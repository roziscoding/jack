import { Database } from 'bun:sqlite'
import { beforeEach, describe, expect, test } from 'bun:test'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { runMigrations } from '../../database/connection'
import * as schema from '../../database/schema'
import { ApiKeysRepository } from './api-keys.repository'

describe('ApiKeysRepository', () => {
  let repo: ApiKeysRepository

  beforeEach(() => {
    const sqlite = new Database(':memory:')
    const db = drizzle({ client: sqlite, schema })
    runMigrations(db)
    repo = new ApiKeysRepository(db)
  })

  test('create() inserts a new key and returns it', () => {
    const result = repo.create({
      keyHash: 'hash123',
      name: 'Test Key',
      description: 'A test key',
    })

    expect(result.id).toBe(1)
    expect(result.keyHash).toBe('hash123')
    expect(result.name).toBe('Test Key')
    expect(result.description).toBe('A test key')
    expect(result.expiresAt).toBeNull()
    expect(result.createdAt).toBeDefined()
    expect(result.updatedAt).toBeDefined()
  })

  test('create() with expiration', () => {
    const expiresAt = new Date(Date.now() + 86400000).toISOString()
    const result = repo.create({
      keyHash: 'hash456',
      expiresAt,
    })

    expect(result.expiresAt).toBe(expiresAt)
  })

  test('findByHash() returns matching record', () => {
    repo.create({ keyHash: 'findme' })

    const result = repo.findByHash('findme')

    expect(result).not.toBeNull()
    expect(result!.keyHash).toBe('findme')
  })

  test('findByHash() returns null for non-existent hash', () => {
    const result = repo.findByHash('nonexistent')

    expect(result).toBeNull()
  })

  test('get() returns record by id', () => {
    const created = repo.create({ keyHash: 'gettest' })

    const result = repo.get(created.id)

    expect(result).not.toBeNull()
    expect(result!.id).toBe(created.id)
  })

  test('list() returns all keys', () => {
    repo.create({ keyHash: 'first', name: 'First' })
    repo.create({ keyHash: 'second', name: 'Second' })

    const result = repo.list()

    expect(result.length).toBe(2)
    const names = result.map(r => r.name).sort()
    expect(names).toEqual(['First', 'Second'])
  })

  test('update() modifies existing record', () => {
    const created = repo.create({ keyHash: 'updateme', name: 'Old Name' })

    const result = repo.update(created.id, { name: 'New Name' })

    expect(result).not.toBeNull()
    expect(result!.name).toBe('New Name')
    expect(result!.updatedAt).toBeDefined()
  })

  test('update() returns null for non-existent id', () => {
    const result = repo.update(999, { name: 'Test' })

    expect(result).toBeNull()
  })

  test('delete() removes record', () => {
    const created = repo.create({ keyHash: 'deleteme' })

    const deleted = repo.delete(created.id)
    const found = repo.get(created.id)

    expect(deleted).toBe(true)
    expect(found).toBeNull()
  })

  test('delete() returns false for non-existent id', () => {
    const result = repo.delete(999)

    expect(result).toBe(false)
  })
})
