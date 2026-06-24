import type { StatusController } from './status.controller'
import { Hono } from 'hono'

export function getStatusRouter(controller: StatusController) {
  const app = new Hono()

  app.get('/overview', c => c.json(controller.getOverview()))
  app.get('/downloads', c => c.json(controller.listDownloads()))

  return app
}
