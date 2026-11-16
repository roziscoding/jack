import type { AuthVariables } from '../../middleware/require-auth'
import type { UploadsService } from '../uploads/uploads.service'
import type { PeerController, StreamFileResult } from './peer.controller'
import { Hono } from 'hono'
import { describeRoute, resolver, validator as zValidator } from 'hono-openapi'
import z from 'zod'
import { PeerCatalogResponse } from '../../lib/peer-catalog'
import { logger } from '../../logger'

// Strip characters that could break out of the quoted filename or inject extra
// response headers (CR/LF/quote). The name comes from a trusted *arr basename, so
// this is defense-in-depth.
const UNSAFE_FILENAME_CHARS = /["\r\n]/g
function safeFilename(name: string): string {
  return name.replace(UNSAFE_FILENAME_CHARS, '')
}

const CreateTransfer = z.object({
  // Stable across the downloading jack's retries of one download, so a create
  // whose response got lost returns the same transfer.
  clientTransferId: z.string().min(1).max(200),
})

const FILE_RESPONSES = {
  200: {
    description: 'Full file stream',
    content: { 'application/octet-stream': {} },
  },
  206: {
    description: 'Partial content for a satisfiable Range request',
    content: { 'application/octet-stream': {} },
  },
  416: { description: 'Unsatisfiable Range request' },
}

function fileResponse(result: StreamFileResult): Response {
  if (result.type === 'unsatisfiable') {
    return new Response(null, {
      status: 416,
      headers: {
        'Content-Range': `bytes */${result.totalSize}`,
        'Accept-Ranges': 'bytes',
      },
    })
  }
  const headers = {
    'Content-Type': 'application/octet-stream',
    'Content-Length': String(result.size),
    'Accept-Ranges': 'bytes',
    'Content-Disposition': `attachment; filename="${safeFilename(result.filename)}"`,
  }
  if (result.type === 'partial') {
    return new Response(result.body, {
      status: 206,
      headers: { ...headers, 'Content-Range': `bytes ${result.start}-${result.end}/${result.totalSize}` },
    })
  }
  return new Response(result.body, { headers })
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
    summary: 'Stream the release file (untracked)',
    description: 'Streams the file straight from disk at the path the local *arr reports, with HTTP Range support. Not recorded as an upload: peers on protocol 0.3.0 and later create a transfer with `POST /peer/items/:itemId/downloads` instead. Kept for older peers.',
    security: [
      { 'X-Api-Key': [] },
    ],
    responses: {
      ...FILE_RESPONSES,
      404: { description: 'No item with this id, or its file is missing on disk' },
    },
  }), async (c) => {
    const result = await controller.streamFile(c.req.param('itemId'), c.req.header('Range'))
    if (!result)
      return c.json({ error: 'File not found' }, 404)
    return fileResponse(result)
  })

  app.post('/items/:itemId/downloads', describeRoute({
    tags: ['Peer'],
    summary: 'Start a transfer',
    description: 'Creates the transfer a peer then streams from `url` and completes with a receipt. Idempotent per api key: the same `clientTransferId` returns the transfer it created before (200) rather than a new one (201). Added in protocol 0.3.0.',
    security: [
      { 'X-Api-Key': [] },
    ],
    responses: {
      200: { description: 'The transfer this `clientTransferId` already created' },
      201: { description: 'The new transfer: `downloadId`, `filename`, `totalBytes` and `url`' },
      404: { description: 'No item with this id, or its file is missing on disk' },
      409: { description: 'This `clientTransferId` already belongs to a transfer of another item' },
    },
  }), zValidator('json', CreateTransfer), async (c) => {
    const itemId = c.req.param('itemId')
    const result = await controller.streamFile(itemId)
    if (!result || result.type !== 'full' || !uploads)
      return c.json({ error: 'File not found' }, 404)
    // The body is a lazy file handle; leaving it unread opens nothing.
    const { upload, created } = uploads.repository.create({
      peerName: c.get('apiKeyName') ?? 'master',
      peerKeyId: c.get('apiKeyId') ?? null,
      itemId,
      filename: result.filename,
      totalBytes: result.size,
      clientTransferId: c.req.valid('json').clientTransferId,
    })
    if (upload.itemId !== itemId)
      return c.json({ error: 'clientTransferId is in use for another item' }, 409)
    return c.json({
      downloadId: upload.transferId,
      filename: upload.filename,
      totalBytes: upload.totalBytes,
      url: `/peer/downloads/${upload.transferId}/file`,
    }, created
      ? 201
      : 200)
  })

  app.get('/downloads/:downloadId/file', describeRoute({
    tags: ['Peer'],
    summary: 'Stream a transfer',
    description: 'Streams the transfer\'s file straight from disk, with HTTP Range support for resuming. Request it as often as needed: every request belongs to the same transfer, and a dropped one leaves it open. Added in protocol 0.3.0.',
    security: [
      { 'X-Api-Key': [] },
    ],
    responses: {
      ...FILE_RESPONSES,
      404: { description: 'No transfer with this id for this api key, or its file is missing on disk' },
    },
  }), async (c) => {
    const upload = uploads?.repository.findOwned(c.req.param('downloadId'), c.get('apiKeyId') ?? null)
    if (!upload)
      return c.json({ error: 'Transfer not found' }, 404)
    const result = await controller.streamFile(upload.itemId, c.req.header('Range'))
    if (!result)
      return c.json({ error: 'File not found' }, 404)
    // A HEAD request sends no body, so it serves nothing. Bookkeeping never fails
    // a transfer: a database error is logged and the file still goes out.
    if (result.type !== 'unsatisfiable' && c.req.method !== 'HEAD') {
      try {
        uploads!.repository.served(upload.id, result.type === 'partial'
          ? result.start
          : 0, {
          filename: result.filename,
          totalBytes: result.type === 'partial'
            ? result.totalSize
            : result.size,
        })
      }
      catch (err) {
        logger.warn({ uploadId: upload.id, err }, 'Could not record a transfer request')
      }
    }
    return fileResponse(result)
  })

  app.post('/downloads/:downloadId/receipt', describeRoute({
    tags: ['Peer'],
    summary: 'Complete a transfer',
    description: 'Sent by the downloading jack once the whole file arrived. jack records the bytes it served and the time since the transfer was created. Always answers 204, so a stale or unknown id is not an error worth retrying. Added in protocol 0.3.0.',
    security: [
      { 'X-Api-Key': [] },
    ],
    responses: {
      204: { description: 'Receipt taken (or ignored)' },
    },
  }), (c) => {
    uploads?.repository.complete(c.req.param('downloadId'), c.get('apiKeyId') ?? null)
    return c.body(null, 204)
  })

  return app
}
