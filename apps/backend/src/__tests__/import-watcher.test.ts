import type { DownloadsRepository } from '../modules/downloads/downloads.repository'
import { dirname } from 'node:path'
import { Database } from 'bun:sqlite'
import { describe, expect, mock, test } from 'bun:test'
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

// A jack_manual import_queued row: the watcher must push an explicit ManualImport
// to *arr (vs. the qB-added rows above, which *arr imports on its own).
function manualRow(repo: DownloadsRepository, qbSourceServer: string) {
  const row = repo.create({
    torrentFilename: 't.torrent',
    peerId: 'peer-1',
    peerName: 'Friend',
    itemId: 'movie:1',
    filename: release.filename,
    destPath: '/tmp/movies/x.mkv',
    partPath: '/tmp/movies/x.mkv.part',
    releaseSize: release.size,
    release,
    qbSourceServer,
    importMode: 'jack_manual',
    importTarget: { kind: 'movie', movieId: 42 },
  })
  repo.markImportQueued(row.id)
  return row
}

function manualServer(name: string, importedHashes: string[], manualImport: (params: unknown) => Promise<void>, opts: { initialized?: boolean } = {}) {
  return {
    name,
    isInitialized: opts.initialized ?? true,
    recentlyImportedDownloadIds: async () => new Set(importedHashes.map(h => h.toLowerCase())),
    manualImport,
  } as any
}

describe('ImportWatcher jack_manual trigger', () => {
  test('pushes manualImport once across two ticks while the hash is absent from history', async () => {
    const repo = makeRepo()
    const row = manualRow(repo, 'My Radarr')
    const manualImport = mock(async () => {})
    const watcher = new ImportWatcher(repo, { servers: [manualServer('My Radarr', [], manualImport)] }, 1000)

    await watcher.tick()
    await watcher.tick()

    expect(manualImport).toHaveBeenCalledTimes(1)
    expect(manualImport).toHaveBeenCalledWith({
      folder: dirname(row.destPath),
      paths: [row.destPath],
      target: { kind: 'movie', movieId: 42 },
      downloadId: HASH,
    })
    expect(repo.get(row.id)?.status).toBe('import_queued')
  })

  test('marks the row imported (and skips the push) once the hash appears in *arr history', async () => {
    const repo = makeRepo()
    const row = manualRow(repo, 'My Radarr')
    const manualImport = mock(async () => {})
    const watcher = new ImportWatcher(repo, { servers: [manualServer('My Radarr', [HASH], manualImport)] }, 1000)

    expect(await watcher.tick()).toBe(1)
    expect(repo.get(row.id)?.status).toBe('imported')
    expect(manualImport).not.toHaveBeenCalled()
  })

  test('re-triggers after a restart (a fresh watcher with an empty triggered set)', async () => {
    const repo = makeRepo()
    manualRow(repo, 'My Radarr')
    const manualImport = mock(async () => {})
    const first = new ImportWatcher(repo, { servers: [manualServer('My Radarr', [], manualImport)] }, 1000)
    await first.tick()
    expect(manualImport).toHaveBeenCalledTimes(1)

    const second = new ImportWatcher(repo, { servers: [manualServer('My Radarr', [], manualImport)] }, 1000)
    await second.tick()
    expect(manualImport).toHaveBeenCalledTimes(2)
  })

  test('retries on the next tick when the manual-import push throws', async () => {
    const repo = makeRepo()
    manualRow(repo, 'My Radarr')
    let calls = 0
    const manualImport = mock(async () => {
      calls++
      if (calls === 1)
        throw new Error('arr down')
    })
    const watcher = new ImportWatcher(repo, { servers: [manualServer('My Radarr', [], manualImport)] }, 1000)

    await watcher.tick()
    await watcher.tick()
    expect(manualImport).toHaveBeenCalledTimes(2)
  })
})
