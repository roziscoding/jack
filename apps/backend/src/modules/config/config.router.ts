import type { ConfigController } from './config.controller'
import { Hono } from 'hono'

export function getConfigRouter(controller: ConfigController) {
  const app = new Hono()

  app.get('/', c => c.json(controller.listConfig()))
  app.get('/peers', c => c.json(controller.listPeers()))
  app.get('/servers', c => c.json(controller.listServers()))

  return app
}
