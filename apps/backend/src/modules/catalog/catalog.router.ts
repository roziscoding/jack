import type { CatalogController } from './catalog.controller'
import { Hono } from 'hono'
import { describeRoute, validator as zValidator } from 'hono-openapi'
import { z } from 'zod'

const tmdbParam = z.object({
  mediaType: z.enum(['movie', 'tv']),
  tmdbId: z.coerce.number().int(),
})

const requestBody = z.object({
  peerId: z.string().min(1),
  serverId: z.string().min(1),
  mediaType: z.enum(['movie', 'tv']),
  tmdbId: z.number().int().optional(),
  tvdbId: z.number().int().optional(),
  rootFolderPath: z.string().min(1),
})

const catalogDoc = (summary: string, description?: string) => describeRoute({
  tags: ['Catalog'],
  summary,
  description,
  security: [{ 'X-Management-Key': [] }],
  responses: { 200: { description: 'Success', content: { 'application/json': {} } } },
})

export function getCatalogRouter(controller: CatalogController) {
  const app = new Hono()

  // Register the static path before any future dynamic segment.
  app.get('/tmdb/status', catalogDoc('TMDB integration status', 'Whether a TMDB API key is configured, so the UI knows if metadata lookups are available.'), async c => c.json(await controller.getTmdbStatus()))

  // Per-title TMDB lookup the catalog grid calls once per visible card.
  app.get('/tmdb/:mediaType/:tmdbId', catalogDoc('Get TMDB title metadata', 'Per-title lookup the catalog grid calls once per visible card.'), zValidator('param', tmdbParam), async (c) => {
    const { mediaType, tmdbId } = c.req.valid('param')
    return c.json(await controller.getTitleMetadata(mediaType, tmdbId))
  })

  app.get('/request-options', catalogDoc('List request targets', 'Destination servers (with root folders) a catalog item can be requested into.'), async c => c.json({ servers: await controller.getRequestOptions() }))

  app.post('/request', catalogDoc('Request a download', 'Grabs a peer\'s catalog item into one of the local destination servers.'), zValidator('json', requestBody), async (c) => {
    return c.json(await controller.requestDownload(c.req.valid('json')))
  })

  // Aggregated catalog across all initialized peers.
  app.get('/', catalogDoc('Get the aggregated catalog', 'Everything available across all initialized peers.'), async c => c.json(await controller.getCatalog()))

  return app
}
