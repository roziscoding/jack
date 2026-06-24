import type { ConfigController } from './config.controller'
import { Hono } from 'hono'
import { validator as zValidator } from 'hono-openapi'
import { z } from 'zod'
import { RawPeerConfig, RawServerConfig } from '../../lib/config'

const idParam = z.object({ id: z.string().min(1) })

export function getConfigRouter(controller: ConfigController) {
  const app = new Hono()

  app.get('/', c => c.json(controller.listConfig()))
  app.get('/peers', c => c.json(controller.listPeers()))
  app.get('/servers', c => c.json(controller.listServers()))

  // Mutation routes only exist when a ConfigService is wired in. Without one, these
  // paths are simply unregistered → 404 (rather than a 500 from an unconfigured call).
  if (controller.canMutate) {
    // `?force=true` persists the peer even if its handshake fails — it stays
    // resident and auto-retries lazily, instead of aborting + rolling back.
    app.post('/peers', zValidator('json', RawPeerConfig), async (c) => {
      const force = c.req.query('force') === 'true'
      return c.json(await controller.addPeer(c.req.valid('json'), { force }), 201)
    })

    app.delete('/peers/:id', zValidator('param', idParam), async (c) => {
      return c.json(await controller.removePeer(c.req.valid('param').id))
    })

    app.patch('/peers/:id', zValidator('param', idParam), zValidator('json', RawPeerConfig), async (c) => {
      const force = c.req.query('force') === 'true'
      return c.json(await controller.updatePeer(c.req.valid('param').id, c.req.valid('json'), { force }))
    })

    app.post('/servers', zValidator('json', RawServerConfig), async (c) => {
      return c.json(await controller.addServer(c.req.valid('json')), 201)
    })

    app.delete('/servers/:id', zValidator('param', idParam), async (c) => {
      return c.json(await controller.removeServer(c.req.valid('param').id))
    })

    app.patch('/servers/:id', zValidator('param', idParam), zValidator('json', RawServerConfig), async (c) => {
      return c.json(await controller.updateServer(c.req.valid('param').id, c.req.valid('json')))
    })
  }

  return app
}
