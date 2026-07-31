import type { StatusController } from './status.controller'
import { Hono } from 'hono'
import { describeRoute } from 'hono-openapi'
import { streamSnapshots } from '../../lib/sse'

export function getStatusRouter(controller: StatusController) {
  const app = new Hono()

  app.get('/overview', describeRoute({
    tags: ['Status'],
    summary: 'Connector overview',
    description: 'Configured servers and peers with their initialization state.',
    security: [{ 'X-Management-Key': [] }],
    responses: { 200: { description: 'Overview of servers and peers', content: { 'application/json': {} } } },
  }), c => c.json(controller.getOverview()))
  app.get('/overview/stream', describeRoute({
    tags: ['Status'],
    summary: 'Stream connector overview',
    description: 'Server-Sent Events stream with an initial overview snapshot and immediate updates when connector or download state changes.',
    security: [{ 'X-Management-Key': [] }],
    responses: { 200: { description: 'Live overview snapshots', content: { 'text/event-stream': {} } } },
  }), c => streamSnapshots(c, () => controller.getOverview(), subscriber => controller.subscribeOverview(subscriber)))
  app.get('/downloads', describeRoute({
    tags: ['Status'],
    summary: 'List downloads',
    description: 'All download records, in-flight and finished.',
    security: [{ 'X-Management-Key': [] }],
    responses: { 200: { description: 'Download records', content: { 'application/json': {} } } },
  }), c => c.json(controller.listDownloads()))
  app.get('/downloads/stream', describeRoute({
    tags: ['Status'],
    summary: 'Stream downloads',
    description: 'Server-Sent Events stream with an initial download snapshot and immediate updates after every persisted download change.',
    security: [{ 'X-Management-Key': [] }],
    responses: { 200: { description: 'Live download snapshots', content: { 'text/event-stream': {} } } },
  }), c => streamSnapshots(c, () => controller.listDownloads(), subscriber => controller.subscribeDownloads(subscriber)))

  return app
}
