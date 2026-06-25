import { Database } from 'bun:sqlite'
import { beforeEach, describe, expect, test } from 'bun:test'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { runMigrations } from '../../database/connection'
import * as schema from '../../database/schema'
import { ManagedKeysRepository } from './managed-keys.repository'

describe('ManagedKeysRepository', () => {
  let repo: ManagedKeysRepository
  beforeEach(() => {
    const sqlite = new Database(':memory:')
    const db = drizzle({ client: sqlite, schema })
    runMigrations(db)
    repo = new ManagedKeysRepository(db)
  })

  test('create + findByHash + findByServerId', () => {
    const row = repo.create({ keyHash: 'h1', serverId: 'srv-a' })
    expect(repo.findByHash('h1')?.id).toBe(row.id)
    expect(repo.findByServerId('srv-a').map(r => r.id)).toEqual([row.id])
    expect(repo.findByHash('nope')).toBeNull()
  })

  test('deleteByServerId keeps only exceptId', () => {
    const a = repo.create({ keyHash: 'h1', serverId: 'srv-a' })
    const b = repo.create({ keyHash: 'h2', serverId: 'srv-a' })
    repo.deleteByServerId('srv-a', b.id)
    expect(repo.findByServerId('srv-a').map(r => r.id)).toEqual([b.id])
    expect(repo.findByHash('h1')).toBeNull()
    void a
  })

  test('deleteOrphans removes non-active servers; empty set clears all', () => {
    repo.create({ keyHash: 'h1', serverId: 'srv-a' })
    repo.create({ keyHash: 'h2', serverId: 'srv-b' })
    repo.deleteOrphans(['srv-a'])
    expect(repo.findByServerId('srv-b')).toHaveLength(0)
    expect(repo.findByServerId('srv-a')).toHaveLength(1)
    repo.deleteOrphans([])
    expect(repo.findByServerId('srv-a')).toHaveLength(0)
  })
})
