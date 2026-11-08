import type { StatusController } from './status.controller'
import { Hono } from 'hono'
import { describeRoute } from 'hono-openapi'
import { streamSnapshots } from '../../lib/sse'

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
    description: 'Per-day transfer volume, average speed and import latency for the last `days` UTC days (default 30, at most 365), lifetime bytes per peer, current failures by error code, the files peers pulled most, and the catalog size history.',
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
    const requested = Number(c.req.query('days') ?? 30)
    const days = Number.isInteger(requested)
      ? Math.min(365, Math.max(1, requested))
      : 30
    return c.json(controller.getStats(days))
  })

  return app
}
