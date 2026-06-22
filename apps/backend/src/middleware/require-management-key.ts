import { createMiddleware } from 'hono/factory'
import { UnauthorizedError } from '../lib/errors/UnauthorizedError'

// Hash both sides to a fixed 32-byte digest so the compare is constant-time and
// length-independent (timingSafeEqual throws on unequal lengths otherwise).
function digest(value: string): Uint8Array {
  return new Bun.CryptoHasher('sha256').update(value).digest() as Uint8Array
}

function constantTimeEqual(a: string, b: string): boolean {
  const da = digest(a)
  const db = digest(b)
  let diff = 0
  for (let i = 0; i < da.length; i++)
    diff |= da[i]! ^ db[i]!
  return diff === 0
}

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
