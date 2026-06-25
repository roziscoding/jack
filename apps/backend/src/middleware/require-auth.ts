import type { ApiKeysRepository } from '../modules/api-keys/api-keys.repository'
import type { ManagedKeysRepository } from '../modules/managed-keys/managed-keys.repository'
import { createMiddleware } from 'hono/factory'
import { hashKey, isGeneratedKey, isManagedKey } from '../lib/crypto'
import { UnauthorizedError } from '../lib/errors/UnauthorizedError'

export interface AuthVariables {
  apiKeyName?: string
}

export function requireApiKey(
  masterKey: string,
  apiKeysRepository?: ApiKeysRepository,
  managedKeysRepository?: ManagedKeysRepository,
) {
  return createMiddleware<{ Variables: AuthVariables }>(async (ctx, next) => {
    const key = ctx.req.query('apikey') ?? ctx.req.header('x-api-key')

    if (!key) {
      throw new UnauthorizedError('missing API key')
    }

    // An empty main key is never a valid comparison target — when no main key is
    // configured, authentication relies entirely on the generated keys below.
    if (masterKey !== '' && key === masterKey) {
      return next()
    }

    // Managed auto-registration keys (jack_managed_) live in their own table; no
    // expiry, no name. Dispatched by prefix so exactly one table is consulted.
    if (isManagedKey(key)) {
      if (managedKeysRepository?.findByHash(hashKey(key))) {
        ctx.set('apiKeyName', 'managed')
        return next()
      }
      throw new UnauthorizedError('invalid API key')
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
