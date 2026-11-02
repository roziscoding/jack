import type { CatalogController } from './catalog.controller'
import { Hono } from 'hono'
import { describeRoute, validator as zValidator } from 'hono-openapi'
import { z } from 'zod'

const tmdbParam = z.object({
  mediaType: z.enum(['movie', 'tv']),
  tmdbId: z.coerce.number().int(),
})

// A repeated query key (`?peer=a&peer=b`) arrives as an array, a single one as a string.
const repeated = z.union([
  z.string(),
  z.array(z.string()),
])
  .optional()
  .transform(value => (value === undefined
    ? []
    : [value].flat()).filter(Boolean))

const catalogQuery = z.object({
  q: z.string().optional(),
  type: z.enum(['all', 'movie', 'tv']).default('all'),
  peer: repeated,
  genre: repeated,
  hideOwned: z.enum(['true', 'false']).default('false').transform(value => value === 'true'),
})

const requestBody = z.object({
  peerId: z.string().min(1),
  serverId: z.string().min(1),
  mediaType: z.enum(['movie', 'tv']),
  tmdbId: z.number().int().optional(),
  tvdbId: z.number().int().optional(),
  rootFolderPath: z.string().min(1),
})

function catalogDoc(summary: string, description?: string) {
  return describeRoute({
    tags: ['Catalog'],
    summary,
    description,
    security: [
      { 'X-Management-Key': [] },
    ],
    responses: {
      200: {
        description: 'Success',
        content: { 'application/json': {} },
      },
    },
  })
}

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

  app.post('/refresh', catalogDoc('Sync the catalog now', 'Runs the catalog sync (this instance\'s catalog, every peer\'s, and the local library) and returns its status once it finishes. Joins a sync that is already running instead of starting another.'), async c => c.json(await controller.refresh()))

  app.get('/', catalogDoc('Get the aggregated catalog', 'Returns the titles matching the query from the cached peer catalogs, which the catalog sync keeps current; no peer is contacted. Best search matches come first, then titles sort the way Radarr and Sonarr sort (a leading "a", "an", or "the" is ignored). `facets` counts each filter value across the whole catalog, and `sync` says when the cache was last synced. Repeat `peer` or `genre` to match any of several values.'), zValidator('query', catalogQuery), (c) => {
    const { q, type, peer, genre, hideOwned } = c.req.valid('query')
    return c.json(controller.getCatalog({
      q,
      type,
      peers: peer,
      genres: genre,
      hideOwned,
    }))
  })

  return app
}
