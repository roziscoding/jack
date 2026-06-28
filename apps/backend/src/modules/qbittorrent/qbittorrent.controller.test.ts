import type { ArrServerConnector } from '../../lib/servers/arr/base'
import { Database } from 'bun:sqlite'
import { beforeEach, describe, expect, test } from 'bun:test'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { runMigrations } from '../../database/connection'
import * as schema from '../../database/schema'
import { generateApiKey, generateManagedKey, hashKey } from '../../lib/crypto'
import { ApiKeysRepository } from '../api-keys/api-keys.repository'
import { DownloadsRepository } from '../downloads/downloads.repository'
import { ManagedKeysRepository } from '../managed-keys/managed-keys.repository'
import { QbittorrentController } from './qbittorrent.controller'

const RADARR = { id: 'srv-a', name: 'Radarr' } as unknown as ArrServerConnector
const SONARR = { id: 'srv-b', name: 'Sonarr' } as unknown as ArrServerConnector

describe('QbittorrentController.login', () => {
  let api: ApiKeysRepository
  let managed: ManagedKeysRepository
  let downloads: DownloadsRepository

  beforeEach(() => {
    const sqlite = new Database(':memory:')
    const db = drizzle({ client: sqlite, schema })
    runMigrations(db)
    api = new ApiKeysRepository(db)
    managed = new ManagedKeysRepository(db)
    downloads = new DownloadsRepository(db)
  })

  function controller(apiKey: string) {
    return new QbittorrentController({
      apiKey,
      completedPath: '/tmp',
      servers: [RADARR, SONARR],
      repository: downloads,
      managedKeysRepository: managed,
    })
  }

  test('unknown username is rejected', () => {
    expect(controller('').login('Nope', generateManagedKey())).toBeNull()
  })

  test('main key passes when set', () => {
    expect(controller('main-key').login('Radarr', 'main-key')).not.toBeNull()
  })

  test('a managed key passes for its own destination', () => {
    const key = generateManagedKey()
    managed.create({ keyHash: hashKey(key), serverId: 'srv-a' })
    expect(controller('').login('Radarr', key)).not.toBeNull()
  })

  test('a managed key is rejected for a different destination (server-scoped)', () => {
    const key = generateManagedKey()
    managed.create({ keyHash: hashKey(key), serverId: 'srv-a' })
    expect(controller('').login('Sonarr', key)).toBeNull()
  })

  test('a peer api_key is rejected — the download client is *arr-only (managed keys)', () => {
    const key = generateApiKey()
    api.create({ keyHash: hashKey(key) })
    expect(controller('').login('Radarr', key)).toBeNull()
  })

  test('with no main key, an unknown password is rejected (no longer open)', () => {
    expect(controller('').login('Radarr', 'whatever')).toBeNull()
  })
})
