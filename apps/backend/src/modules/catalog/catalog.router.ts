import type { CatalogController } from './catalog.controller'
import { Hono } from 'hono'
import { validator as zValidator } from 'hono-openapi'
import { z } from 'zod'

const peerParam = z.object({ peerId: z.string().min(1) })

export function getCatalogRouter(controller: CatalogController) {
  const app = new Hono()

  // Register the static path before `/:peerId` so "tmdb" isn't captured as a peerId.
  app.get('/tmdb/status', async c => c.json(await controller.getTmdbStatus()))

  app.get('/:peerId', zValidator('param', peerParam), async (c) => {
    const { peerId } = c.req.valid('param')
    return c.json(await controller.getPeerCatalog(peerId))
  })

  return app
}
