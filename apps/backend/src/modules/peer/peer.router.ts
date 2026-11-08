import type { AuthVariables } from '../../middleware/require-auth'
import type { UploadsService } from '../uploads/uploads.service'
import type { PeerController } from './peer.controller'
import { Hono } from 'hono'
import { describeRoute, resolver, validator as zValidator } from 'hono-openapi'
import z from 'zod'
import { PeerCatalogResponse } from '../../lib/peer-catalog'

// Strip characters that could break out of the quoted filename or inject extra
// response headers (CR/LF/quote). The name comes from a trusted *arr basename, so
// this is defense-in-depth.
const UNSAFE_FILENAME_CHARS = /["\r\n]/g
function safeFilename(name: string): string {
  return name.replace(UNSAFE_FILENAME_CHARS, '')
}

export function getPeerRouter(controller: PeerController, uploads?: UploadsService) {
  const app = new Hono<{ Variables: AuthVariables }>()

  app.get(
    '/search',
    describeRoute({
      tags: ['Peer'],
      summary: 'Search this library',
      description: 'Search the local Radarr/Sonarr libraries by external id. Only movies/episodes that have files are returned. Serves empty results when no local source is configured.',
      security: [
        { 'X-Api-Key': [] },
      ],
      responses: {
        200: {
          description: 'Matching releases, mirroring the *arr file metadata',
          content: {
            'application/json': {
              schema: resolver(z.object({
                items: z.array(z.record(z.string(), z.unknown())),
              })),
            },
          },
        },
      },
    }),
    zValidator('query', z.object({
      imdbId: z.string().optional(),
      tmdbId: z.string().optional(),
      tvdbId: z.string().optional(),
      season: z.coerce.number().int().optional(),
      episode: z.coerce.number().int().optional(),
    })),
    async (c) => {
      const params = c.req.valid('query')
      const results = await controller.search(params)
      return c.json({ items: results })
    },
  )

  app.get('/catalog', describeRoute({
    tags: ['Peer'],
    summary: 'List this library by title',
    description: 'One entry per movie or series that has files in the source Radarr/Sonarr libraries, with release totals, the distinct resolutions available, artwork, and genres. Served from the catalog as of the last sync, limited to the sources enabled now. Pass the `revision` and `generation` from a previous response as `since` and `generation` to get only what changed after it; without them, or when the generation changed (this instance\'s database was reset), the whole catalog comes back with `full: true`. Added in protocol 0.2.0; older peers only serve `/search`.',
    security: [
      { 'X-Api-Key': [] },
    ],
    responses: {
      200: {
        description: 'Per-title summaries of the library, or the changes since `since`',
        content: {
          'application/json': {
            schema: resolver(PeerCatalogResponse),
          },
        },
      },
    },
  }), zValidator('query', z.object({
    since: z.coerce.number().int().nonnegative().optional(),
    generation: z.string().optional(),
  })), (c) => {
    const { since, generation } = c.req.valid('query')
    return c.json(controller.catalog(since, generation))
  })

  app.get('/items/:itemId', describeRoute({
    tags: ['Peer'],
    summary: 'Get release metadata',
    security: [
      { 'X-Api-Key': [] },
    ],
    responses: {
      200: { description: 'Release metadata for the item' },
      404: { description: 'No item with this id' },
    },
  }), async (c) => {
    const { itemId } = c.req.param()
    const item = await controller.getItem(itemId)
    if (!item) {
      return c.json({ error: 'Not found' }, 404)
    }
    return c.json(item)
  })

  app.get('/items/:itemId/file', describeRoute({
    tags: ['Peer'],
    summary: 'Stream the release file',
    description: 'Streams the file straight from disk at the path the local *arr reports. Supports HTTP Range requests for resumable transfers.',
    security: [
      { 'X-Api-Key': [] },
    ],
    responses: {
      200: {
        description: 'Full file stream',
        content: { 'application/octet-stream': {} },
      },
      206: {
        description: 'Partial content for a satisfiable Range request',
        content: { 'application/octet-stream': {} },
      },
      404: { description: 'No item with this id, or its file is missing on disk' },
      416: { description: 'Unsatisfiable Range request' },
    },
  }), async (c) => {
    const { itemId } = c.req.param()
    const result = await controller.streamFile(itemId, c.req.header('Range'))

    if (!result) {
      return c.json({ error: 'File not found' }, 404)
    }

    if (result.type === 'unsatisfiable') {
      return new Response(null, {
        status: 416,
        headers: {
          'Content-Range': `bytes */${result.totalSize}`,
          'Accept-Ranges': 'bytes',
        },
      })
    }

    // Count what the peer actually reads. A HEAD request sends no body, so it is
    // not an upload. The master key sets no name.
    const body = uploads && c.req.method !== 'HEAD'
      ? uploads.track({
          peerName: c.get('apiKeyName') ?? 'master',
          itemId,
          filename: result.filename,
          totalBytes: result.type === 'partial'
            ? result.totalSize
            : result.size,
          rangeStart: result.type === 'partial'
            ? result.start
            : 0,
          requestedBytes: result.size,
        }, result.body, c.req.raw.signal)
      : result.body

    if (result.type === 'partial') {
      return new Response(body, {
        status: 206,
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Length': String(result.size),
          'Content-Range': `bytes ${result.start}-${result.end}/${result.totalSize}`,
          'Accept-Ranges': 'bytes',
          'Content-Disposition': `attachment; filename="${safeFilename(result.filename)}"`,
        },
      })
    }

    return new Response(body, {
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(result.size),
        'Accept-Ranges': 'bytes',
        'Content-Disposition': `attachment; filename="${result.filename}"`,
      },
    })
  })

  return app
}
