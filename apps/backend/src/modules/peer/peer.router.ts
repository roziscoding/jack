import type { PeerController } from './peer.controller'
import { Hono } from 'hono'
import { validator as zValidator } from 'hono-openapi'
import z from 'zod'

export function getPeerRouter(controller: PeerController) {
  const app = new Hono()

  app.get(
    '/search',
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

  app.get('/items/:itemId', async (c) => {
    const { itemId } = c.req.param()
    const item = await controller.getItem(itemId)
    if (!item) {
      return c.json({ error: 'Not found' }, 404)
    }
    return c.json(item)
  })

  app.get('/items/:itemId/file', async (c) => {
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

    if (result.type === 'partial') {
      return new Response(result.stream, {
        status: 206,
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Length': String(result.size),
          'Content-Range': `bytes ${result.start}-${result.end}/${result.totalSize}`,
          'Accept-Ranges': 'bytes',
          'Content-Disposition': `attachment; filename="${result.filename}"`,
        },
      })
    }

    return new Response(result.stream, {
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
