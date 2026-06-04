import { createMiddleware } from 'hono/factory'
import { UnauthorizedError } from '../lib/errors/UnauthorizedError'

let _middleware: ReturnType<typeof createMiddleware> | null = null

export function requireApiKey(apiKey: string) {
  _middleware ??= createMiddleware((ctx, next) => {
    if (apiKey === '') {
      return next()
    }
    const key = ctx.req.query('apikey') ?? ctx.req.header('x-api-key')

    if (!key) {
      throw new UnauthorizedError('missing API key')
    }

    if (key === apiKey) {
      return next()
    }

    throw new UnauthorizedError('invalid API key')
  })

  return _middleware
}
