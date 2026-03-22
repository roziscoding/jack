import type { ServersController } from './servers.controllers'
import { Hono } from 'hono'

export function getServersRouter(controller: ServersController) {
  const app = new Hono()

  app.get('/health', async (c) => {
    return c.json(await controller.getIssues())
  })

  app.get('/', async (c) => {
    return c.json(controller.listServers())
  })

  return app
}
