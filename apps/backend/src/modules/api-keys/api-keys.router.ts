import type { ApiKeysController } from './api-keys.controller'
import { Hono } from 'hono'
import { validator as zValidator } from 'hono-openapi'
import z from 'zod'
import { CreateApiKeyBody, UpdateApiKeyBody } from './api-keys.schema'

const idParam = z.object({
  id: z.coerce.number().int().positive(),
})

export function getApiKeysRouter(controller: ApiKeysController) {
  const app = new Hono()

  app.post('/', zValidator('json', CreateApiKeyBody), (c) => {
    const body = c.req.valid('json')
    const result = controller.create(body)
    return c.json(result, 201)
  })

  app.get('/', (c) => {
    const result = controller.list()
    return c.json(result)
  })

  app.get('/:id', zValidator('param', idParam), (c) => {
    const { id } = c.req.valid('param')
    const result = controller.get(id)
    return c.json(result)
  })

  app.patch('/:id', zValidator('param', idParam), zValidator('json', UpdateApiKeyBody), (c) => {
    const { id } = c.req.valid('param')
    const body = c.req.valid('json')
    const result = controller.update(id, body)
    return c.json(result)
  })

  app.delete('/:id', zValidator('param', idParam), (c) => {
    const { id } = c.req.valid('param')
    const result = controller.delete(id)
    return c.json(result)
  })

  return app
}
