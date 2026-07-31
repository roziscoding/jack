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

async function readUntil(reader: ReadableStreamDefaultReader<Uint8Array>, expected: string): Promise<string> {
  const decoder = new TextDecoder()
  let buffer = ''
  for (let i = 0; i < 50 && !buffer.includes(expected); i++) {
    const { value, done } = await reader.read()
    if (done)
      break
    buffer += decoder.decode(value, { stream: true })
  }
  return buffer
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

  test('GET /overview surfaces import-queued, failed and bytes moved', async () => {
    const { app, downloadsRepository } = makeApp()
    const base = {
      torrentFilename: 'm.torrent',
      peerId: 'p',
      peerName: 'Friend Jack',
      itemId: 'movie:1',
      destPath: '/tmp/x.mkv',
      partPath: '/tmp/x.mkv.part',
      releaseSize: 100,
      release: { id: 'r', title: 'm', filename: 'm.mkv', category: 2000, size: 100 } as any,
    }

    const downloading = downloadsRepository.create({ ...base, filename: 'a.mkv' })
    downloadsRepository.updateProgress(downloading.id, 40)
    // Flag the in-flight transfer with a size mismatch.
    downloadsRepository.setExpectedBytes(downloading.id, 40, null, true)

    const queued = downloadsRepository.create({ ...base, filename: 'b.mkv' })
    downloadsRepository.updateProgress(queued.id, 100)
    downloadsRepository.markImportQueued(queued.id)

    const failed = downloadsRepository.create({ ...base, filename: 'c.mkv' })
    downloadsRepository.updateProgress(failed.id, 10)
    downloadsRepository.markFailed(failed.id, 'boom')

    const res = await app.request('/overview', { headers: KEY })
    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.downloads.byStatus.import_queued).toBe(1)
    expect(body.downloads.byStatus.failed).toBe(1)
    expect(body.downloads.importQueued).toHaveLength(1)
    expect(body.downloads.importQueued[0].filename).toBe('b.mkv')
    expect(body.downloads.failed).toHaveLength(1)
    expect(body.downloads.failed[0].error).toBe('boom')
    // 40 + 100 + 10 bytes pulled across the three transfers.
    expect(body.downloads.bytesMoved).toBe(150)
    // Only the in-flight transfer carries a size mismatch.
    expect(body.downloads.mismatched).toBe(1)
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

  test('GET /downloads/stream pushes a new snapshot when download state changes', async () => {
    const { app, downloadsRepository } = makeApp()
    const ac = new AbortController()
    const res = await app.request('/downloads/stream', { headers: KEY, signal: ac.signal })

    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/event-stream')
    const reader = res.body!.getReader() as unknown as ReadableStreamDefaultReader<Uint8Array>

    try {
      const initial = await readUntil(reader, '"downloads":[]')
      expect(initial).toContain('"downloads":[]')

      downloadsRepository.create({
        torrentFilename: 'live.torrent',
        peerId: 'p',
        peerName: 'Friend Jack',
        itemId: 'movie:2',
        filename: 'live.mkv',
        destPath: '/tmp/live.mkv',
        partPath: '/tmp/live.mkv.part',
        releaseSize: 100,
        release: { id: 'r2', title: 'live', filename: 'live.mkv', category: 2000, size: 100 } as any,
      })

      const update = await readUntil(reader, 'live.mkv')
      expect(update).toContain('live.mkv')
    }
    finally {
      await reader.cancel().catch(() => {})
      ac.abort()
    }
  })

  test('GET /config/stream pushes a new snapshot when connector state changes', async () => {
    const manager = new ConnectorManager([], [{ url: 'http://peer.test:3000', apiKey: 'peer-key', name: 'Friend Jack', headers: {} }])
    const peer = manager.peers[0]!
    const app = getManagementApp({ environment: 'test', managementKey: 'mgmt-secret', connectors: manager })
    const ac = new AbortController()
    const res = await app.request('/config/stream', { headers: KEY, signal: ac.signal })

    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/event-stream')
    const reader = res.body!.getReader() as unknown as ReadableStreamDefaultReader<Uint8Array>

    try {
      const initial = await readUntil(reader, 'Friend Jack')
      expect(initial).toContain('Friend Jack')

      manager.removeConnector(peer.id)

      const update = await readUntil(reader, '"peers":[]')
      expect(update).toContain('"peers":[]')
    }
    finally {
      await reader.cancel().catch(() => {})
      ac.abort()
    }
  })

  test('GET /config/stream restores the final snapshot after a connector add rolls back', async () => {
    const manager = new ConnectorManager([], [])
    const app = getManagementApp({ environment: 'test', managementKey: 'mgmt-secret', connectors: manager })
    const ac = new AbortController()
    const res = await app.request('/config/stream', { headers: KEY, signal: ac.signal })
    const reader = res.body!.getReader() as unknown as ReadableStreamDefaultReader<Uint8Array>

    try {
      expect(await readUntil(reader, '"peers":[]')).toContain('"peers":[]')

      await expect(manager.addPeerConnector({
        url: 'http://127.0.0.1:1',
        apiKey: 'peer-key',
        name: 'Unavailable peer',
        headers: {},
      }, { rethrowInitError: true })).rejects.toThrow()

      const final = await readUntil(reader, '"peers":[]')
      expect(final).toContain('"peers":[]')
      expect(manager.peers).toEqual([])
    }
    finally {
      await reader.cancel().catch(() => {})
      ac.abort()
    }
  })
})
