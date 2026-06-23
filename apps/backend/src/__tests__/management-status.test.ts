import { Database } from 'bun:sqlite'
import { afterEach, describe, expect, test } from 'bun:test'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { runMigrations } from '../database/connection'
import * as schema from '../database/schema'
import { ConnectorManager } from '../lib/servers'
import { PeerConnector } from '../lib/servers/peer'
import { getManagementApp } from '../management-app'
import { DownloadsRepository } from '../modules/downloads/downloads.repository'

const KEY = { 'X-Management-Key': 'mgmt-secret' } as const

function markInitialized<T extends object>(connector: T): T {
  const c = connector as any
  c._isInitialized = true
  c._initState = 'initialized'
  c._initialization.resolve()
  return connector
}

function makePeer() {
  return markInitialized(new PeerConnector({ url: 'http://peer.test:3000', apiKey: 'peer-api-key', name: 'Friend Jack' }))
}

const dbsToClose: Database[] = []
afterEach(() => {
  for (const db of dbsToClose.splice(0))
    db.close()
})

function makeApp() {
  const manager = new ConnectorManager([], [])
  const peer = makePeer()
  ;(manager as any)._peerMap.set(peer.id, peer)

  const database = new Database(':memory:')
  dbsToClose.push(database)
  database.exec('pragma foreign_keys = ON')
  const db = drizzle({ client: database, schema })
  runMigrations(db)
  const downloadsRepository = new DownloadsRepository(db)

  const app = getManagementApp({ environment: 'test', managementKey: 'mgmt-secret', connectors: manager, downloadsRepository })
  return { app, downloadsRepository, peer }
}

describe('Management status endpoints', () => {
  test('GET /ping returns 200 with a valid key', async () => {
    const { app } = makeApp()
    const res = await app.request('/ping', { headers: KEY })
    expect(res.status).toBe(200)
  })

  test('GET /ping returns 401 without a key', async () => {
    const { app } = makeApp()
    const res = await app.request('/ping')
    expect(res.status).toBe(401)
  })

  test('GET /overview summarizes peers, servers and downloads', async () => {
    const { app, downloadsRepository } = makeApp()
    downloadsRepository.create({
      torrentFilename: 'm.torrent',
      peerId: 'p',
      peerName: 'Friend Jack',
      itemId: 'movie:1',
      filename: 'm.mkv',
      destPath: '/tmp/m.mkv',
      partPath: '/tmp/m.mkv.part',
      releaseSize: 100,
      release: { id: 'r', title: 'm', filename: 'm.mkv', category: 2000, size: 100 } as any,
    })

    const res = await app.request('/overview', { headers: KEY })
    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.peers.total).toBe(1)
    expect(body.peers.initialized).toBe(1)
    expect(body.downloads.total).toBe(1)
    expect(body.downloads.byStatus.downloading).toBe(1)
    expect(body.downloads.active).toHaveLength(1)
  })

  test('GET /downloads returns enriched records with progress', async () => {
    const { app, downloadsRepository } = makeApp()
    const dl = downloadsRepository.create({
      torrentFilename: 'm.torrent',
      peerId: 'p',
      peerName: 'Friend Jack',
      itemId: 'movie:1',
      filename: 'm.mkv',
      destPath: '/tmp/m.mkv',
      partPath: '/tmp/m.mkv.part',
      releaseSize: 100,
      release: { id: 'r', title: 'm', filename: 'm.mkv', category: 2000, size: 100 } as any,
    })
    downloadsRepository.updateProgress(dl.id, 25)

    const res = await app.request('/downloads', { headers: KEY })
    expect(res.status).toBe(200)
    const body = await res.json() as { downloads: Array<{ progress: number, totalBytes: number }> }
    expect(body.downloads[0]?.totalBytes).toBe(100)
    expect(body.downloads[0]?.progress).toBeCloseTo(0.25)
  })
})
