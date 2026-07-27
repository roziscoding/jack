import type { ApiKeysController } from './api-keys.controller'
import { Hono } from 'hono'
import { describeRoute, validator as zValidator } from 'hono-openapi'
import z from 'zod'
import { CreateApiKeyBody, UpdateApiKeyBody } from './api-keys.schema'

const idParam = z.object({
  id: z.coerce.number().int().positive(),
})

function apiKeysDoc(summary: string, description?: string, status = 200) {
  return describeRoute({
    tags: ['API keys'],
    summary,
    description,
    security: [{ 'X-Management-Key': [] }],
    responses: { [status]: { description: 'Success', content: { 'application/json': {} } } },
  })
}

export function getApiKeysRouter(controller: ApiKeysController) {
  const app = new Hono()

  app.post('/', apiKeysDoc('Create a peer API key', 'Issues a named, revocable, optionally expiring key. The plaintext key is only returned by this call.', 201), zValidator('json', CreateApiKeyBody), (c) => {
    const body = c.req.valid('json')
    const result = controller.create(body)
    return c.json(result, 201)
  })

  app.get('/', apiKeysDoc('List peer API keys'), (c) => {
    const result = controller.list()
    return c.json(result)
  })

  app.get('/:id', apiKeysDoc('Get a peer API key'), zValidator('param', idParam), (c) => {
    const { id } = c.req.valid('param')
    const result = controller.get(id)
    return c.json(result)
  })

  app.patch('/:id', apiKeysDoc('Update a peer API key'), zValidator('param', idParam), zValidator('json', UpdateApiKeyBody), (c) => {
    const { id } = c.req.valid('param')
    const body = c.req.valid('json')
    const result = controller.update(id, body)
    return c.json(result)
  })

  app.delete('/:id', apiKeysDoc('Revoke a peer API key'), zValidator('param', idParam), (c) => {
    const { id } = c.req.valid('param')
    const result = controller.delete(id)
    return c.json(result)
  })

  return app
}
