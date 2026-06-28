import type { ApiKeysRepository } from '../modules/api-keys/api-keys.repository'
import type { ManagedKeysRepository } from '../modules/managed-keys/managed-keys.repository'
import { createMiddleware } from 'hono/factory'
import { constantTimeEqual, hashKey, isGeneratedKey, isManagedKey } from '../lib/crypto'
import { UnauthorizedError } from '../lib/errors/UnauthorizedError'

export interface AuthVariables {
  apiKeyName?: string
}

// Each protected surface accepts exactly one class of key, so the scope is mounted
// per route group rather than globally:
//  - `api_key`     → peer-facing routes (/handshake, /peer/*). Peers present the
//                    regular API keys stored in the api_keys table.
//  - `managed_key` → *arr-facing routes (/torznab/*). Jack mints these and pushes
//                    them into Radarr/Sonarr, so they live in the managed_keys table.
// The operator master key is a universal override on either scope. The repository is
// required: a scope that can't validate its own key class would silently degrade to
// master-key-only (locking out every peer / *arr), so we make that impossible to wire.
export type ApiKeyScope
  = | { type: 'api_key', repository: ApiKeysRepository }
    | { type: 'managed_key', repository: ManagedKeysRepository }

export function requireApiKey(masterKey: string, scope: ApiKeyScope) {
  return createMiddleware<{ Variables: AuthVariables }>(async (ctx, next) => {
    const key = ctx.req.query('apikey') ?? ctx.req.header('x-api-key')

    if (!key) {
      throw new UnauthorizedError('missing API key')
    }

    // An empty master key is never a valid comparison target — when none is
    // configured, authentication relies entirely on the scoped table below.
    if (masterKey !== '' && constantTimeEqual(key, masterKey)) {
      return next()
    }

    if (scope.type === 'managed_key') {
      // A key without the managed prefix can't belong to this scope — reject before
      // touching the table (and before any peer api_key could reach the *arr surface).
      if (!isManagedKey(key)) {
        throw new UnauthorizedError('invalid API key')
      }
      if (scope.repository.findByHash(hashKey(key))) {
        ctx.set('apiKeyName', 'managed')
        return next()
      }
      throw new UnauthorizedError('invalid API key')
    }

    // Peer scope: regular api_keys only. Managed keys are excluded by prefix, so a
    // managed (*arr) key can't reach the peer surface.
    if (!isGeneratedKey(key)) {
      throw new UnauthorizedError('invalid API key')
    }

    const resolution = scope.repository.resolve(key)
    if (resolution.status === 'missing') {
      throw new UnauthorizedError('invalid API key')
    }
    if (resolution.status === 'expired') {
      throw new UnauthorizedError('API key expired')
    }

    ctx.set('apiKeyName', resolution.row.name ?? 'unnamed')
    return next()
  })
}
