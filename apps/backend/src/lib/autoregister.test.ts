import type { ManagedRegistrationDeps } from './autoregister'
import type { ArrServerConnector } from './servers/arr/base'
import { Database } from 'bun:sqlite'
import { beforeEach, describe, expect, test } from 'bun:test'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { runMigrations } from '../database/connection'
import * as schema from '../database/schema'
import { ManagedKeysRepository } from '../modules/managed-keys/managed-keys.repository'
import { ManagedApiKeys } from '../modules/managed-keys/managed-keys.service'
import { registerManagedForDestination } from './autoregister'

describe('registerManagedForDestination', () => {
  let repo: ManagedKeysRepository
  let service: ManagedApiKeys

  beforeEach(() => {
    const sqlite = new Database(':memory:')
    const db = drizzle({ client: sqlite, schema })
    runMigrations(db)
    repo = new ManagedKeysRepository(db)
    service = new ManagedApiKeys(repo)
  })

  function stubDest(over: Partial<{ registerIndexer: () => Promise<void>, registerDownloadClient: () => Promise<number> }> = {}): ArrServerConnector {
    return {
      id: 'srv-a',
      name: 'Radarr',
      categories: [2000],
      autoRegister: { enable: true, priority: 1 },
      registerDownloadClient: over.registerDownloadClient ?? (async () => 1),
      registerIndexer: over.registerIndexer ?? (async () => {}),
    } as unknown as ArrServerConnector
  }

  function deps(): ManagedRegistrationDeps {
    return {
      managedKeys: service,
      internalUrl: 'http://jack:5225',
      downloads: true,
      category: 'jack-srv-a',
      onSuccess: () => {},
      onFailure: () => {},
    }
  }

  test('full success commits — only the new key remains', async () => {
    const old = service.provision('srv-a')
    await registerManagedForDestination(stubDest(), deps())
    const rows = repo.findByServerId('srv-a')
    expect(rows).toHaveLength(1)
    expect(rows[0]!.id).not.toBe(old.id)
  })

  test('partial failure (indexer fails) keeps both old and new keys', async () => {
    const old = service.provision('srv-a')
    await registerManagedForDestination(
      stubDest({ registerIndexer: async () => { throw new Error('boom') } }),
      deps(),
    )
    const ids = repo.findByServerId('srv-a').map(r => r.id)
    expect(ids).toContain(old.id)
    expect(ids).toHaveLength(2)
  })

  test('partial failure (download client fails) keeps both old and new keys', async () => {
    const old = service.provision('srv-a')
    await registerManagedForDestination(
      stubDest({ registerDownloadClient: async () => { throw new Error('dc') } }),
      deps(),
    )
    const ids = repo.findByServerId('srv-a').map(r => r.id)
    expect(ids).toContain(old.id)
    expect(ids).toHaveLength(2)
  })

  test('total failure discards the new key (only the old remains)', async () => {
    const old = service.provision('srv-a')
    await registerManagedForDestination(
      stubDest({
        registerDownloadClient: async () => { throw new Error('dc') },
        registerIndexer: async () => { throw new Error('ix') },
      }),
      deps(),
    )
    expect(repo.findByServerId('srv-a').map(r => r.id)).toEqual([old.id])
  })

  test('downloads disabled + indexer failure discards the new key', async () => {
    const old = service.provision('srv-a')
    await registerManagedForDestination(
      stubDest({ registerIndexer: async () => { throw new Error('ix') } }),
      { ...deps(), downloads: false },
    )
    expect(repo.findByServerId('srv-a').map(r => r.id)).toEqual([old.id])
  })
})
