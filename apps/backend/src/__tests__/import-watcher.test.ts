import type { DownloadsRepository } from '../modules/downloads/downloads.repository'
import { Database } from 'bun:sqlite'
import { describe, expect, test } from 'bun:test'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { runMigrations } from '../database/connection'
import * as schema from '../database/schema'
import { DownloadsRepository as Repo } from '../modules/downloads/downloads.repository'
import { ImportWatcher } from '../modules/downloads/import-watcher'
import { deriveHash } from '../modules/qbittorrent/qbittorrent.mapper'

const release = { id: 'r', title: 'Movie.2024.1080p', filename: 'Movie.2024.1080p.mkv', category: 2000, size: 100 } as any
const HASH = deriveHash(release.title, release.size)

function makeRepo(): DownloadsRepository {
  const database = new Database(':memory:')
  database.exec('pragma foreign_keys = ON')
  const db = drizzle({ client: database, schema })
  runMigrations(db)
  return new Repo(db)
}

// Create a row already at import_queued (download finished, awaiting *arr import).
function queuedRow(repo: DownloadsRepository, qbSourceServer: string | null) {
  const row = repo.create({
    torrentFilename: 't.torrent',
    peerId: 'peer-1',
    peerName: 'Friend',
    itemId: 'movie:1',
    filename: release.filename,
    destPath: '/tmp/x.mkv',
    partPath: '/tmp/x.mkv.part',
    releaseSize: release.size,
    release,
    qbSourceServer,
  })
  repo.markImportQueued(row.id)
  return row
}

function fakeServer(name: string, importedHashes: string[], opts: { initialized?: boolean } = {}) {
  return {
    name,
    isInitialized: opts.initialized ?? true,
    recentlyImportedDownloadIds: async () => new Set(importedHashes.map(h => h.toLowerCase())),
  } as any
}

describe('ImportWatcher', () => {
  test('flips import_queued → imported when *arr reports the hash (case-insensitively)', async () => {
    const repo = makeRepo()
    const row = queuedRow(repo, 'My Radarr')
    // *arr reports the infohash uppercased — the watcher must still match it.
    const watcher = new ImportWatcher(repo, { servers: [fakeServer('My Radarr', [HASH.toUpperCase()])] }, 1000)

    expect(await watcher.tick()).toBe(1)
    expect(repo.get(row.id)?.status).toBe('imported')
  })

  test('leaves the row at import_queued until *arr imports it', async () => {
    const repo = makeRepo()
    const row = queuedRow(repo, 'My Radarr')
    const watcher = new ImportWatcher(repo, { servers: [fakeServer('My Radarr', [])] }, 1000)

    expect(await watcher.tick()).toBe(0)
    expect(repo.get(row.id)?.status).toBe('import_queued')
  })

  test('skips rows with no source server (blackhole) and uninitialized connectors', async () => {
    const repo = makeRepo()
    const blackhole = queuedRow(repo, null)
    const down = queuedRow(repo, 'Down Radarr')
    const watcher = new ImportWatcher(repo, {
      servers: [fakeServer('Down Radarr', [HASH], { initialized: false })],
    }, 1000)

    expect(await watcher.tick()).toBe(0)
    expect(repo.get(blackhole.id)?.status).toBe('import_queued')
    expect(repo.get(down.id)?.status).toBe('import_queued')
  })

  test('a history read failure leaves the row for the next tick', async () => {
    const repo = makeRepo()
    const row = queuedRow(repo, 'Flaky Radarr')
    const server = {
      name: 'Flaky Radarr',
      isInitialized: true,
      recentlyImportedDownloadIds: async () => { throw new Error('upstream down') },
    } as any
    const watcher = new ImportWatcher(repo, { servers: [server] }, 1000)

    expect(await watcher.tick()).toBe(0)
    expect(repo.get(row.id)?.status).toBe('import_queued')
  })
})
