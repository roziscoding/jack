import type { DownloadsController } from './downloads.controller'
import { Hono } from 'hono'
import { validator as zValidator } from 'hono-openapi'
import z from 'zod'

export function getDownloadsRouter(controller: DownloadsController) {
  const app = new Hono()

  app.get('/', (c) => {
    return c.json(controller.listDownloads())
  })

  app.get(
    '/:id',
    zValidator('param', z.object({ id: z.coerce.number().int().positive() })),
    (c) => {
      const { id } = c.req.valid('param')
      const download = controller.getDownload(id)

      if (!download)
        return c.json({ error: 'Not found' }, 404)

      return c.json(download)
    },
  )

  return app
}
