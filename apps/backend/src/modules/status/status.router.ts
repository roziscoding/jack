import type { StatusController } from './status.controller'
import { Hono } from 'hono'
import { describeRoute } from 'hono-openapi'
import { streamSnapshots } from '../../lib/sse'
import { DEFAULT_STATS_RANGE, isStatsRange, STATS_RANGES } from '../stats/stats'

export function getStatusRouter(controller: StatusController) {
  const app = new Hono()

  app.get('/overview', describeRoute({
    tags: ['System'],
    summary: 'Connector overview',
    description: 'Configured servers and peers with their initialization state.',
    security: [
      { 'X-Management-Key': [] },
    ],
    responses: {
      200: {
        description: 'Overview of servers and peers',
        content: { 'application/json': {} },
      },
    },
  }), c => c.json(controller.getOverview()))
  app.get('/overview/stream', describeRoute({
    tags: ['System'],
    summary: 'Stream connector overview',
    description: 'Server-Sent Events stream with an initial overview snapshot and immediate updates when connector or download state changes.',
    security: [
      { 'X-Management-Key': [] },
    ],
    responses: {
      200: {
        description: 'Live overview snapshots',
        content: { 'text/event-stream': {} },
      },
    },
  }), c => streamSnapshots(c, () => controller.getOverview(), subscriber => controller.subscribeOverview(subscriber)))
  app.get('/downloads', describeRoute({
    tags: ['Downloads'],
    summary: 'List downloads',
    description: 'All download records, in-flight and finished.',
    security: [
      { 'X-Management-Key': [] },
    ],
    responses: {
      200: {
        description: 'Download records',
        content: { 'application/json': {} },
      },
    },
  }), c => c.json(controller.listDownloads()))
  app.get('/downloads/stream', describeRoute({
    tags: ['Downloads'],
    summary: 'Stream downloads',
    description: 'Server-Sent Events stream with an initial download snapshot and immediate updates after every persisted download change.',
    security: [
      { 'X-Management-Key': [] },
    ],
    responses: {
      200: {
        description: 'Live download snapshots',
        content: { 'text/event-stream': {} },
      },
    },
  }), c => streamSnapshots(c, () => controller.listDownloads(), subscriber => controller.subscribeDownloads(subscriber)))
  app.get('/uploads', describeRoute({
    tags: ['Uploads'],
    summary: 'List uploads',
    description: 'Files peers pulled or are pulling from this instance, newest first. One record per file request, so a resumed transfer adds a record that starts at its `rangeStart`.',
    security: [
      { 'X-Management-Key': [] },
    ],
    responses: {
      200: {
        description: 'Upload records',
        content: { 'application/json': {} },
      },
    },
  }), c => c.json(controller.listUploads()))
  app.get('/uploads/stream', describeRoute({
    tags: ['Uploads'],
    summary: 'Stream uploads',
    description: 'Server-Sent Events stream with an initial upload snapshot and an update after every upload change, at most about once a second while files stream.',
    security: [
      { 'X-Management-Key': [] },
    ],
    responses: {
      200: {
        description: 'Live upload snapshots',
        content: { 'text/event-stream': {} },
      },
    },
  }), c => streamSnapshots(c, () => controller.listUploads(), subscriber => controller.subscribeUploads(subscriber)))

  app.get('/stats', describeRoute({
    tags: ['Status'],
    summary: 'Dashboard statistics',
    description: 'Transfer volume, average speed and import latency over a history window, plus lifetime bytes per peer, current failures by error code, the five files peers pulled most, and the daily catalog size history. `range` picks the window and its bucket width: `5m` (10 s buckets), `30m` (1 min), `1h` (2 min), `24h` (1 h), `7d` (6 h) or `30d` (1 day, the default).',
    parameters: [
      {
        name: 'range',
        in: 'query',
        required: false,
        schema: {
          type: 'string',
          enum: Object.keys(STATS_RANGES),
          default: DEFAULT_STATS_RANGE,
        },
      },
    ],
    security: [
      { 'X-Management-Key': [] },
    ],
    responses: {
      200: {
        description: 'Dashboard statistics',
        content: { 'application/json': {} },
      },
    },
  }), (c) => {
    const requested = c.req.query('range')
    return c.json(controller.getStats(isStatsRange(requested)
      ? requested
      : DEFAULT_STATS_RANGE))
  })

  return app
}
