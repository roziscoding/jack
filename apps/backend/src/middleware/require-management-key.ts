import { createMiddleware } from 'hono/factory'
import { constantTimeEqual } from '../lib/crypto'
import { UnauthorizedError } from '../lib/errors/UnauthorizedError'

export function requireManagementKey(managementKey: string) {
  return createMiddleware((ctx, next) => {
    const provided = ctx.req.header('x-management-key')

    if (!provided)
      throw new UnauthorizedError('missing management key')

    if (constantTimeEqual(provided, managementKey))
      return next()

    throw new UnauthorizedError('invalid management key')
  })
}
