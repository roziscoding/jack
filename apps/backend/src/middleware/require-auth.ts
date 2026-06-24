import type { ApiKeysRepository } from '../modules/api-keys/api-keys.repository'
import { createMiddleware } from 'hono/factory'
import { hashKey, isGeneratedKey } from '../lib/crypto'
import { UnauthorizedError } from '../lib/errors/UnauthorizedError'

export interface AuthVariables {
  apiKeyName?: string
}

export function requireApiKey(masterKey: string, apiKeysRepository?: ApiKeysRepository) {
  return createMiddleware<{ Variables: AuthVariables }>(async (ctx, next) => {
    if (masterKey === '') {
      return next()
    }

    const key = ctx.req.query('apikey') ?? ctx.req.header('x-api-key')

    if (!key) {
      throw new UnauthorizedError('missing API key')
    }

    if (key === masterKey) {
      return next()
    }

    if (!isGeneratedKey(key)) {
      throw new UnauthorizedError('invalid API key')
    }

    if (!apiKeysRepository) {
      throw new UnauthorizedError('invalid API key')
    }

    const keyHash = hashKey(key)
    const apiKey = apiKeysRepository.findByHash(keyHash)

    if (!apiKey) {
      throw new UnauthorizedError('invalid API key')
    }

    if (apiKey.expiresAt) {
      const expiresAt = new Date(apiKey.expiresAt)
      if (expiresAt <= new Date()) {
        throw new UnauthorizedError('API key expired')
      }
    }

    ctx.set('apiKeyName', apiKey.name ?? 'unnamed')

    return next()
  })
}
