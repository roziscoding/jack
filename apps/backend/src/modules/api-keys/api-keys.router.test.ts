import { Database } from 'bun:sqlite'
import { beforeEach, describe, expect, test } from 'bun:test'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { Hono } from 'hono'
import { runMigrations } from '../../database/connection'
import * as schema from '../../database/schema'
import { handleError } from '../../middleware/handle-error'
import { ApiKeysController } from './api-keys.controller'
import { ApiKeysRepository } from './api-keys.repository'
import { getApiKeysRouter } from './api-keys.router'

interface ApiKeyResponse {
  id: number
  key?: string
  name: string | null
  description: string | null
  expiresAt: string | null
  createdAt: string
  updatedAt: string
  keyHash?: never
}

describe('API Keys Router', () => {
  let app: Hono

  beforeEach(() => {
    const sqlite = new Database(':memory:')
    const db = drizzle({ client: sqlite, schema })
    runMigrations(db)

    const repo = new ApiKeysRepository(db)
    const controller = new ApiKeysController(repo)

    app = new Hono()
    app.route('/api-keys', getApiKeysRouter(controller))
    app.onError(handleError('test'))
  })

  describe('POST /api-keys', () => {
    test('creates key and returns it with raw key', async () => {
      const res = await app.request('/api-keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Test Key', description: 'For testing' }),
      })

      expect(res.status).toBe(201)
      const body = await res.json() as ApiKeyResponse
      expect(body.id).toBe(1)
      expect(body.key).toMatch(/^jack_[a-f0-9]{64}$/)
      expect(body.name).toBe('Test Key')
      expect(body.description).toBe('For testing')
    })

    test('creates key with expiration', async () => {
      const expiresAt = new Date(Date.now() + 86400000).toISOString()
      const res = await app.request('/api-keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ expiresAt }),
      })

      expect(res.status).toBe(201)
      const body = await res.json() as ApiKeyResponse
      expect(body.expiresAt).toBe(expiresAt)
    })

    test('creates key with no metadata', async () => {
      const res = await app.request('/api-keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })

      expect(res.status).toBe(201)
      const body = await res.json() as ApiKeyResponse
      expect(body.key).toMatch(/^jack_/)
    })
  })

  describe('GET /api-keys', () => {
    test('lists all keys without hashes', async () => {
      await app.request('/api-keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Key 1' }),
      })
      await app.request('/api-keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Key 2' }),
      })

      const res = await app.request('/api-keys')

      expect(res.status).toBe(200)
      const body = await res.json() as ApiKeyResponse[]
      expect(body.length).toBe(2)
      expect(body[0]!.key).toBeUndefined()
      expect(body[0]!.keyHash).toBeUndefined()
    })
  })

  describe('GET /api-keys/:id', () => {
    test('returns key by id', async () => {
      const createRes = await app.request('/api-keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Get Test' }),
      })
      const created = await createRes.json() as ApiKeyResponse

      const res = await app.request(`/api-keys/${created.id}`)

      expect(res.status).toBe(200)
      const body = await res.json() as ApiKeyResponse
      expect(body.id).toBe(created.id)
      expect(body.name).toBe('Get Test')
    })

    test('returns 404 for non-existent id', async () => {
      const res = await app.request('/api-keys/999')

      expect(res.status).toBe(404)
    })
  })

  describe('PATCH /api-keys/:id', () => {
    test('updates key metadata', async () => {
      const createRes = await app.request('/api-keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Original' }),
      })
      const created = await createRes.json() as ApiKeyResponse

      const res = await app.request(`/api-keys/${created.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Updated' }),
      })

      expect(res.status).toBe(200)
      const body = await res.json() as ApiKeyResponse
      expect(body.name).toBe('Updated')
    })

    test('returns 404 for non-existent id', async () => {
      const res = await app.request('/api-keys/999', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Test' }),
      })

      expect(res.status).toBe(404)
    })
  })

  describe('DELETE /api-keys/:id', () => {
    test('deletes key', async () => {
      const createRes = await app.request('/api-keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Delete Me' }),
      })
      const created = await createRes.json() as ApiKeyResponse

      const res = await app.request(`/api-keys/${created.id}`, {
        method: 'DELETE',
      })

      expect(res.status).toBe(200)
      const body = await res.json() as { ok: boolean }
      expect(body.ok).toBe(true)

      const getRes = await app.request(`/api-keys/${created.id}`)
      expect(getRes.status).toBe(404)
    })

    test('returns 404 for non-existent id', async () => {
      const res = await app.request('/api-keys/999', {
        method: 'DELETE',
      })

      expect(res.status).toBe(404)
    })
  })
})
