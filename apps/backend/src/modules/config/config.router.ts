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

  app.delete('/peers/:id', async (c) => {
    return c.json(await controller.removePeer(c.req.param('id')))
  })

  app.patch('/peers/:id', async (c) => {
    const body = await c.req.json().catch(() => null)
    return c.json(await controller.updatePeer(c.req.param('id'), body))
  })

  app.post('/servers', async (c) => {
    const body = await c.req.json().catch(() => null)
    return c.json(await controller.addServer(body), 201)
  })

  app.delete('/servers/:id', async (c) => {
    return c.json(await controller.removeServer(c.req.param('id')))
  })

  app.patch('/servers/:id', async (c) => {
    const body = await c.req.json().catch(() => null)
    return c.json(await controller.updateServer(c.req.param('id'), body))
  })

  return app
}
