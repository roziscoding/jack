import { Database } from 'bun:sqlite'
import { beforeEach, describe, expect, test } from 'bun:test'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { runMigrations } from '../../database/connection'
import * as schema from '../../database/schema'
import { hashKey, isManagedKey } from '../../lib/crypto'
import { ManagedKeysRepository } from './managed-keys.repository'
import { ManagedApiKeys } from './managed-keys.service'

describe('ManagedApiKeys', () => {
  let repo: ManagedKeysRepository
  let service: ManagedApiKeys
  beforeEach(() => {
    const sqlite = new Database(':memory:')
    const db = drizzle({ client: sqlite, schema })
    runMigrations(db)
    repo = new ManagedKeysRepository(db)
    service = new ManagedApiKeys(repo)
  })

  test('provision persists the hash of the returned key', () => {
    const { id, key } = service.provision('srv-a')
    expect(isManagedKey(key)).toBe(true)
    expect(repo.findByHash(hashKey(key))?.id).toBe(id)
  })

  test('commit keeps only the latest row for the server', () => {
    service.provision('srv-a')
    const second = service.provision('srv-a')
    service.commit('srv-a', second.id)
    expect(repo.findByServerId('srv-a').map(r => r.id)).toEqual([second.id])
  })

  test('prune removes rows for inactive servers', () => {
    service.provision('srv-a')
    service.provision('srv-b')
    service.prune(['srv-a'])
    expect(repo.findByServerId('srv-b')).toHaveLength(0)
    expect(repo.findByServerId('srv-a')).toHaveLength(1)
  })

  test('discard removes a single provisioned row', () => {
    const old = service.provision('srv-a')
    const fresh = service.provision('srv-a')
    service.discard(fresh.id)
    expect(repo.findByServerId('srv-a').map(r => r.id)).toEqual([old.id])
  })
})
