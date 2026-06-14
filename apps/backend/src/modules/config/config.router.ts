import type { ConfigController } from './config.controller'
import { Hono } from 'hono'

export function getConfigRouter(controller: ConfigController) {
  const app = new Hono()

  app.get('/', c => c.json(controller.listConfig()))
  app.get('/peers', c => c.json(controller.listPeers()))
  app.get('/servers', c => c.json(controller.listServers()))

  app.post('/peers', async (c) => {
    const body = await c.req.json().catch(() => null)
    return c.json(await controller.addPeer(body), 201)
  })

  return app
}
