import type { StatusController } from './status.controller'
import { Hono } from 'hono'
import { describeRoute } from 'hono-openapi'

export function getStatusRouter(controller: StatusController) {
  const app = new Hono()

  app.get('/overview', describeRoute({
    tags: ['Status'],
    summary: 'Connector overview',
    description: 'Configured servers and peers with their initialization state.',
    security: [{ 'X-Management-Key': [] }],
    responses: { 200: { description: 'Overview of servers and peers', content: { 'application/json': {} } } },
  }), c => c.json(controller.getOverview()))
  app.get('/downloads', describeRoute({
    tags: ['Status'],
    summary: 'List downloads',
    description: 'All download records, in-flight and finished.',
    security: [{ 'X-Management-Key': [] }],
    responses: { 200: { description: 'Download records', content: { 'application/json': {} } } },
  }), c => c.json(controller.listDownloads()))

  return app
}
