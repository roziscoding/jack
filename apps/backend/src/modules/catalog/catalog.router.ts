import type { CatalogController } from './catalog.controller'
import { Hono } from 'hono'
import { validator as zValidator } from 'hono-openapi'
import { z } from 'zod'

const peerParam = z.object({ peerId: z.string().min(1) })

const requestBody = z.object({
  serverId: z.string().min(1),
  mediaType: z.enum(['movie', 'tv']),
  tmdbId: z.number().int().optional(),
  tvdbId: z.number().int().optional(),
  rootFolderPath: z.string().min(1),
})

export function getCatalogRouter(controller: CatalogController) {
  const app = new Hono()

  // Register the static path before `/:peerId` so "tmdb" isn't captured as a peerId.
  app.get('/tmdb/status', async c => c.json(await controller.getTmdbStatus()))

  // Register before `/:peerId` so "request-options" isn't captured as a peerId.
  app.get('/request-options', async c => c.json({ servers: await controller.getRequestOptions() }))

  app.post('/request', zValidator('json', requestBody), async (c) => {
    return c.json(await controller.requestDownload(c.req.valid('json')))
  })

  app.get('/:peerId', zValidator('param', peerParam), async (c) => {
    const { peerId } = c.req.valid('param')
    return c.json(await controller.getPeerCatalog(peerId))
  })

  return app
}
