import type { ApiKeysController } from './api-keys.controller'
import { Hono } from 'hono'
import { validator as zValidator } from 'hono-openapi'
import { z } from 'zod'

const createApiKeySchema = z.object({
  name: z.string().max(100).nullish(),
  description: z.string().max(500).nullish(),
  expiresAt: z.string().datetime().nullish(),
})

const updateApiKeySchema = z.object({
  name: z.string().max(100).nullish(),
  description: z.string().max(500).nullish(),
  expiresAt: z.string().datetime().nullish(),
})

const idParamSchema = z.object({
  id: z.coerce.number().int().positive(),
})

export function getApiKeysRouter(controller: ApiKeysController) {
  const app = new Hono()

  app.post('/', zValidator('json', createApiKeySchema), (c) => {
    const body = c.req.valid('json')
    const result = controller.create(body)
    return c.json(result, 201)
  })

  app.get('/', (c) => {
    const result = controller.list()
    return c.json(result)
  })

  app.get('/:id', zValidator('param', idParamSchema), (c) => {
    const { id } = c.req.valid('param')
    const result = controller.get(id)
    return c.json(result)
  })

  app.patch('/:id', zValidator('param', idParamSchema), zValidator('json', updateApiKeySchema), (c) => {
    const { id } = c.req.valid('param')
    const body = c.req.valid('json')
    const result = controller.update(id, body)
    return c.json(result)
  })

  app.delete('/:id', zValidator('param', idParamSchema), (c) => {
    const { id } = c.req.valid('param')
    const result = controller.delete(id)
    return c.json(result)
  })

  return app
}
