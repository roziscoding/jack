import type { AuthVariables } from './require-auth'
import { Database } from 'bun:sqlite'
import { beforeEach, describe, expect, test } from 'bun:test'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { Hono } from 'hono'
import { runMigrations } from '../database/connection'
import * as schema from '../database/schema'
import { generateApiKey, hashKey } from '../lib/crypto'
import { ApiKeysRepository } from '../modules/api-keys/api-keys.repository'
import { handleError } from './handle-error'
import { requireApiKey } from './require-auth'

interface SuccessResponse {
  keyName: string | null
}

interface ErrorResponse {
  ok: false
  error: { message: string }
}

describe('requireApiKey', () => {
  let repo: ApiKeysRepository
  const masterKey = 'master-secret-key'

  beforeEach(() => {
    const sqlite = new Database(':memory:')
    const db = drizzle({ client: sqlite, schema })
    runMigrations(db)
    repo = new ApiKeysRepository(db)
  })

  function createApp(apiKey: string, repository?: ApiKeysRepository) {
    const app = new Hono<{ Variables: AuthVariables }>()
    app.use('*', requireApiKey(apiKey, repository))
    app.get('/test', c => c.json({ keyName: c.get('apiKeyName') ?? null }))
    app.onError(handleError('test'))
    return app
  }

  test('missing key returns 401', async () => {
    const app = createApp(masterKey, repo)

    const res = await app.request('/test')

    expect(res.status).toBe(401)
    const body = await res.json() as SuccessResponse | ErrorResponse
    expect((body as ErrorResponse).error.message).toContain('missing API key')
  })

  test('master key passes without DB lookup', async () => {
    const app = createApp(masterKey, repo)

    const res = await app.request('/test', {
      headers: { 'X-Api-Key': masterKey },
    })

    expect(res.status).toBe(200)
    const body = await res.json() as SuccessResponse | ErrorResponse
    expect((body as SuccessResponse).keyName).toBeNull()
  })

  test('empty master key disables auth', async () => {
    const app = createApp('', repo)

    const res = await app.request('/test')

    expect(res.status).toBe(200)
  })

  test('valid jack_ key from DB passes and sets name', async () => {
    const key = generateApiKey()
    repo.create({ keyHash: hashKey(key), name: 'Test Key' })
    const app = createApp(masterKey, repo)

    const res = await app.request('/test', {
      headers: { 'X-Api-Key': key },
    })

    expect(res.status).toBe(200)
    const body = await res.json() as SuccessResponse | ErrorResponse
    expect((body as SuccessResponse).keyName).toBe('Test Key')
  })

  test('valid jack_ key without name sets "unnamed"', async () => {
    const key = generateApiKey()
    repo.create({ keyHash: hashKey(key) })
    const app = createApp(masterKey, repo)

    const res = await app.request('/test', {
      headers: { 'X-Api-Key': key },
    })

    expect(res.status).toBe(200)
    const body = await res.json() as SuccessResponse | ErrorResponse
    expect((body as SuccessResponse).keyName).toBe('unnamed')
  })

  test('expired jack_ key returns 401', async () => {
    const key = generateApiKey()
    const pastDate = new Date(Date.now() - 86400000).toISOString()
    repo.create({ keyHash: hashKey(key), expiresAt: pastDate })
    const app = createApp(masterKey, repo)

    const res = await app.request('/test', {
      headers: { 'X-Api-Key': key },
    })

    expect(res.status).toBe(401)
    const body = await res.json() as SuccessResponse | ErrorResponse
    expect((body as ErrorResponse).error.message).toContain('API key expired')
  })

  test('non-existent jack_ key returns 401', async () => {
    const key = generateApiKey()
    const app = createApp(masterKey, repo)

    const res = await app.request('/test', {
      headers: { 'X-Api-Key': key },
    })

    expect(res.status).toBe(401)
    const body = await res.json() as SuccessResponse | ErrorResponse
    expect((body as ErrorResponse).error.message).toContain('invalid API key')
  })

  test('non-jack_ key that does not match master returns 401 (no DB lookup)', async () => {
    const app = createApp(masterKey, repo)

    const res = await app.request('/test', {
      headers: { 'X-Api-Key': 'wrong-key' },
    })

    expect(res.status).toBe(401)
    const body = await res.json() as SuccessResponse | ErrorResponse
    expect((body as ErrorResponse).error.message).toContain('invalid API key')
  })

  test('jack_ key without repository returns 401', async () => {
    const key = generateApiKey()
    const app = createApp(masterKey)

    const res = await app.request('/test', {
      headers: { 'X-Api-Key': key },
    })

    expect(res.status).toBe(401)
  })

  test('key via query param works', async () => {
    const app = createApp(masterKey, repo)

    const res = await app.request(`/test?apikey=${masterKey}`)

    expect(res.status).toBe(200)
  })
})
