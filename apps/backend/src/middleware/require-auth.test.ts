import type { AuthVariables } from './require-auth'
import { Database } from 'bun:sqlite'
import { beforeEach, describe, expect, test } from 'bun:test'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { Hono } from 'hono'
import { runMigrations } from '../database/connection'
import * as schema from '../database/schema'
import { generateApiKey, generateManagedKey, hashKey } from '../lib/crypto'
import { ApiKeysRepository } from '../modules/api-keys/api-keys.repository'
import { ManagedKeysRepository } from '../modules/managed-keys/managed-keys.repository'
import { handleError } from './handle-error'
import { requireApiKey } from './require-auth'

interface SuccessResponse {
  keyName: string | null
}

interface ErrorResponse {
  ok: false
  error: { message: string }
}

const masterKey = 'master-secret-key'

describe('requireApiKey', () => {
  let apiRepo: ApiKeysRepository
  let managedRepo: ManagedKeysRepository

  beforeEach(() => {
    const sqlite = new Database(':memory:')
    const db = drizzle({ client: sqlite, schema })
    runMigrations(db)
    apiRepo = new ApiKeysRepository(db)
    managedRepo = new ManagedKeysRepository(db)
  })

  // The middleware renders rejection reasons in detail only with exposeDetails (the
  // management/log view); the peer API renders them opaquely — see handle-error.test.ts.
  function apiKeyApp(master: string, repository = apiRepo) {
    const app = new Hono<{ Variables: AuthVariables }>()
    app.use('*', requireApiKey(master, { type: 'api_key', repository }))
    app.get('/test', c => c.json({ keyName: c.get('apiKeyName') ?? null }))
    app.onError(handleError('test', { exposeDetails: true }))
    return app
  }

  function managedKeyApp(master: string, repository = managedRepo) {
    const app = new Hono<{ Variables: AuthVariables }>()
    app.use('*', requireApiKey(master, { type: 'managed_key', repository }))
    app.get('/test', c => c.json({ keyName: c.get('apiKeyName') ?? null }))
    app.onError(handleError('test', { exposeDetails: true }))
    return app
  }

  describe('shared behaviour', () => {
    test('missing key returns 401', async () => {
      const res = await apiKeyApp(masterKey).request('/test')
      expect(res.status).toBe(401)
      expect(((await res.json()) as ErrorResponse).error.message).toContain('missing API key')
    })

    test('master key passes without a DB lookup', async () => {
      const res = await apiKeyApp(masterKey).request('/test', { headers: { 'X-Api-Key': masterKey } })
      expect(res.status).toBe(200)
      expect(((await res.json()) as SuccessResponse).keyName).toBeNull()
    })

    test('master key passes on the managed scope too', async () => {
      const res = await managedKeyApp(masterKey).request('/test', { headers: { 'X-Api-Key': masterKey } })
      expect(res.status).toBe(200)
    })

    test('empty master key: a missing key is still rejected (auth not disabled)', async () => {
      const res = await apiKeyApp('').request('/test')
      expect(res.status).toBe(401)
      expect(((await res.json()) as ErrorResponse).error.message).toContain('missing API key')
    })

    test('key via query param works', async () => {
      const res = await apiKeyApp(masterKey).request(`/test?apikey=${masterKey}`)
      expect(res.status).toBe(200)
    })
  })

  describe('api_key scope (peers)', () => {
    test('empty master key: a valid generated key still passes via the DB', async () => {
      const key = generateApiKey()
      apiRepo.create({ keyHash: hashKey(key), name: 'Gen Key' })

      const res = await apiKeyApp('').request('/test', { headers: { 'X-Api-Key': key } })
      expect(res.status).toBe(200)
      expect(((await res.json()) as SuccessResponse).keyName).toBe('Gen Key')
    })

    test('a valid jack_ key passes and sets its name', async () => {
      const key = generateApiKey()
      apiRepo.create({ keyHash: hashKey(key), name: 'Test Key' })

      const res = await apiKeyApp(masterKey).request('/test', { headers: { 'X-Api-Key': key } })
      expect(res.status).toBe(200)
      expect(((await res.json()) as SuccessResponse).keyName).toBe('Test Key')
    })

    test('a valid jack_ key without a name sets "unnamed"', async () => {
      const key = generateApiKey()
      apiRepo.create({ keyHash: hashKey(key) })

      const res = await apiKeyApp(masterKey).request('/test', { headers: { 'X-Api-Key': key } })
      expect(res.status).toBe(200)
      expect(((await res.json()) as SuccessResponse).keyName).toBe('unnamed')
    })

    test('an expired jack_ key returns 401', async () => {
      const key = generateApiKey()
      apiRepo.create({ keyHash: hashKey(key), expiresAt: new Date(Date.now() - 86400000).toISOString() })

      const res = await apiKeyApp(masterKey).request('/test', { headers: { 'X-Api-Key': key } })
      expect(res.status).toBe(401)
      expect(((await res.json()) as ErrorResponse).error.message).toContain('API key expired')
    })

    test('a non-existent jack_ key returns 401', async () => {
      const res = await apiKeyApp(masterKey).request('/test', { headers: { 'X-Api-Key': generateApiKey() } })
      expect(res.status).toBe(401)
      expect(((await res.json()) as ErrorResponse).error.message).toContain('invalid API key')
    })

    test('a non-jack_ key that is not the master returns 401 (no DB lookup)', async () => {
      const res = await apiKeyApp(masterKey).request('/test', { headers: { 'X-Api-Key': 'wrong-key' } })
      expect(res.status).toBe(401)
      expect(((await res.json()) as ErrorResponse).error.message).toContain('invalid API key')
    })

    test('a managed key is rejected on the peer scope (wrong prefix, fails fast)', async () => {
      const key = generateManagedKey()
      managedRepo.create({ keyHash: hashKey(key), serverId: 'srv-a' })

      const res = await apiKeyApp(masterKey).request('/test', { headers: { 'X-Api-Key': key } })
      expect(res.status).toBe(401)
      expect(((await res.json()) as ErrorResponse).error.message).toContain('invalid API key')
    })
  })

  describe('managed_key scope (*arr)', () => {
    test('a valid managed key passes via the managed table', async () => {
      const key = generateManagedKey()
      managedRepo.create({ keyHash: hashKey(key), serverId: 'srv-a' })

      const res = await managedKeyApp(masterKey).request('/test', { headers: { 'X-Api-Key': key } })
      expect(res.status).toBe(200)
      expect(((await res.json()) as SuccessResponse).keyName).toBe('managed')
    })

    test('an unknown managed key returns 401', async () => {
      const res = await managedKeyApp(masterKey).request('/test', { headers: { 'X-Api-Key': generateManagedKey() } })
      expect(res.status).toBe(401)
    })

    test('a peer api_key is rejected on the *arr scope (wrong prefix, fails fast)', async () => {
      const key = generateApiKey()
      apiRepo.create({ keyHash: hashKey(key), name: 'Peer Key' })

      const res = await managedKeyApp(masterKey).request('/test', { headers: { 'X-Api-Key': key } })
      expect(res.status).toBe(401)
      expect(((await res.json()) as ErrorResponse).error.message).toContain('invalid API key')
    })
  })
})
