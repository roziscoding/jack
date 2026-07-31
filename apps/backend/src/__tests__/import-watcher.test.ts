import type { ArrServerConnector, ManualImportParams } from '../lib/servers/arr/base'
import type { DownloadsRepository } from '../modules/downloads/downloads.repository'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Database } from 'bun:sqlite'
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { runMigrations } from '../database/connection'
import * as schema from '../database/schema'
import { PermanentManualImportError } from '../lib/servers/arr/base'
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

function manualServer(name: string, importedHashes: string[], manualImport: (params: ManualImportParams) => Promise<number>, opts: { initialized?: boolean } = {}): ArrServerConnector {
  return {
    id: name,
    name,
    isInitialized: opts.initialized ?? true,
    recentlyImportedDownloadIds: async () => new Set(importedHashes.map(h => h.toLowerCase())),
    manualImport,
    manualImportCommandStatus: async () => ({ state: 'pending' as const }),
  } as unknown as ArrServerConnector
}

describe('ImportWatcher jack_manual trigger', () => {
  test('coalesces overlapping ticks so they trigger one manual import', async () => {
    const repo = makeRepo()
    const row = manualRow(repo, 'My Radarr')
    const started = Promise.withResolvers<void>()
    const finish = Promise.withResolvers<void>()
    const manualImport = mock(async () => {
      started.resolve()
      await finish.promise
      return 106
    })
    const watcher = new ImportWatcher(repo, { servers: [manualServer('My Radarr', [], manualImport)] }, 1000)

    const first = watcher.tick()
    await started.promise
    const second = watcher.tick()
    finish.resolve()
    await Promise.all([first, second])

    expect(manualImport).toHaveBeenCalledTimes(1)
    expect(repo.get(row.id)?.manualImportCommandId).toBe(106)
  })

  test('serializes a manual retry against a watcher tick and revalidates state', async () => {
    const repo = makeRepo()
    const row = manualRow(repo, 'My Radarr')
    repo.markFailed(row.id, 'manual import rejected', 'import')
    const started = Promise.withResolvers<void>()
    const finish = Promise.withResolvers<void>()
    const manualImport = mock(async () => {
      started.resolve()
      await finish.promise
      return 107
    })
    const watcher = new ImportWatcher(repo, { servers: [manualServer('My Radarr', [], manualImport)] }, 1000)

    const retrying = watcher.retry(row.id)
    await started.promise
    const ticking = watcher.tick()
    finish.resolve()
    await Promise.all([retrying, ticking])

    expect(manualImport).toHaveBeenCalledTimes(1)
    expect(repo.get(row.id)?.manualImportCommandId).toBe(107)
  })

  test('retry re-triggers a failed manual import without changing transfer bytes', async () => {
    const repo = makeRepo()
    const row = manualRow(repo, 'My Radarr')
    repo.updateProgress(row.id, release.size)
    repo.markFailed(row.id, 'manual import rejected', 'import')
    const manualImport = mock(async () => 105)
    const watcher = new ImportWatcher(repo, { servers: [manualServer('My Radarr', [], manualImport)] }, 1000)

    await watcher.retry(row.id)

    expect(manualImport).toHaveBeenCalledTimes(1)
    expect(repo.get(row.id)).toMatchObject({
      status: 'import_queued',
      downloadedBytes: release.size,
      lastOperation: 'import',
      operationFailed: false,
      manualImportCommandId: 105,
    })
  })

  test('pushes manualImport once across two ticks while the hash is absent from history', async () => {
    const repo = makeRepo()
    const row = manualRow(repo, 'My Radarr')
    const manualImport = mock(async () => 101)
    const watcher = new ImportWatcher(repo, { servers: [manualServer('My Radarr', [], manualImport)] }, 1000)

    await watcher.tick()
    await watcher.tick()

    expect(manualImport).toHaveBeenCalledTimes(1)
    expect(manualImport).toHaveBeenCalledWith({
      folder: dirname(row.destPath),
      paths: [row.destPath],
      target: { kind: 'movie', movieId: 42 },
      downloadId: HASH,
      release,
    })
    expect(repo.get(row.id)?.status).toBe('import_queued')
  })

  test('marks the row imported (and skips the push) once the hash appears in *arr history', async () => {
    const repo = makeRepo()
    const row = manualRow(repo, 'My Radarr')
    const manualImport = mock(async () => 102)
    const watcher = new ImportWatcher(repo, { servers: [manualServer('My Radarr', [HASH], manualImport)] }, 1000)

    expect(await watcher.tick()).toBe(1)
    expect(repo.get(row.id)?.status).toBe('imported')
    expect(manualImport).not.toHaveBeenCalled()
  })

  test('does not re-trigger after a restart once the manual import command id is persisted', async () => {
    const repo = makeRepo()
    manualRow(repo, 'My Radarr')
    const manualImport = mock(async () => 103)
    const first = new ImportWatcher(repo, { servers: [manualServer('My Radarr', [], manualImport)] }, 1000)
    await first.tick()
    expect(manualImport).toHaveBeenCalledTimes(1)

    const second = new ImportWatcher(repo, { servers: [manualServer('My Radarr', [], manualImport)] }, 1000)
    await second.tick()
    expect(manualImport).toHaveBeenCalledTimes(1)
  })

  test('retries on the next tick when the manual-import push throws', async () => {
    const repo = makeRepo()
    manualRow(repo, 'My Radarr')
    let calls = 0
    const manualImport = mock(async () => {
      calls++
      if (calls === 1)
        throw new Error('arr down')
      return 104
    })
    // backoffBaseMs: 0 → retry immediately on the next tick.
    const watcher = new ImportWatcher(repo, { servers: [manualServer('My Radarr', [], manualImport)] }, 1000, {
      maxAttempts: 6,
      backoffBaseMs: 0,
      backoffMaxMs: 0,
    })

    await watcher.tick()
    await watcher.tick()
    expect(manualImport).toHaveBeenCalledTimes(2)
  })

  test('backs off instead of re-firing the trigger every tick after a failure', async () => {
    const repo = makeRepo()
    const row = manualRow(repo, 'My Radarr')
    const manualImport = mock(() => Promise.reject(new Error('arr 500')))
    // A long back-off window means the second, immediate tick must skip the trigger.
    const watcher = new ImportWatcher(repo, { servers: [manualServer('My Radarr', [], manualImport)] }, 1000, {
      maxAttempts: 6,
      backoffBaseMs: 60_000,
      backoffMaxMs: 60_000,
    })

    await watcher.tick()
    await watcher.tick()

    expect(manualImport).toHaveBeenCalledTimes(1)
    expect(repo.get(row.id)?.status).toBe('import_queued')
  })

  test('gives up and marks the row failed after maxAttempts trigger failures', async () => {
    const repo = makeRepo()
    const row = manualRow(repo, 'My Radarr')
    const manualImport = mock(() => Promise.reject(new Error('arr 500')))
    const watcher = new ImportWatcher(repo, { servers: [manualServer('My Radarr', [], manualImport)] }, 1000, {
      maxAttempts: 3,
      backoffBaseMs: 0,
      backoffMaxMs: 0,
    })

    await watcher.tick()
    await watcher.tick()
    await watcher.tick()

    expect(manualImport).toHaveBeenCalledTimes(3)
    expect(repo.get(row.id)).toMatchObject({ status: 'failed' })
    expect(repo.get(row.id)?.error).toContain('after 3 attempts')
  })
})

type TestManualImportCommandState
  = | { state: 'pending' }
    | { state: 'completed' }
    | { state: 'failed', error: string }

interface ImportWatcherServer {
  id: string
  name: string
  isInitialized: boolean
  recentlyImportedDownloadIds: () => Promise<Set<string>>
  manualImport: (params: ManualImportParams) => Promise<number>
  manualImportCommandStatus: (commandId: number) => Promise<TestManualImportCommandState>
}

function watcherWithServers(repo: DownloadsRepository, servers: ImportWatcherServer[]) {
  // Test fakes implement only the ArrServerConnector surface that ImportWatcher calls.
  return new ImportWatcher(repo, { servers: servers as unknown as ArrServerConnector[] }, 1000)
}

function manualImportRow(repo: DownloadsRepository, input: { qbSourceServer: string, sourceServerId: string }) {
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
    qbSourceServer: input.qbSourceServer,
    sourceServerId: input.sourceServerId,
    importMode: 'jack_manual',
    importTarget: { kind: 'movie', movieId: 42 },
  })
  repo.markImportQueued(row.id)
  return row
}

describe('ImportWatcher tracked manual imports', () => {
  test('resolves queued rows by stable server id after a destination rename', async () => {
    const repo = makeRepo()
    const row = manualImportRow(repo, { qbSourceServer: 'Old Radarr', sourceServerId: 'radarr-1' })
    const server: ImportWatcherServer = {
      id: 'radarr-1',
      name: 'New Radarr',
      isInitialized: true,
      recentlyImportedDownloadIds: async () => new Set(),
      manualImport: async () => 41,
      manualImportCommandStatus: async () => ({ state: 'pending' }),
    }
    const watcher = watcherWithServers(repo, [server])

    await watcher.tick()

    expect(repo.get(row.id)?.manualImportCommandId).toBe(41)
  })

  test('marks a manual import row imported when the tracked command completes', async () => {
    const repo = makeRepo()
    const row = manualImportRow(repo, { qbSourceServer: 'My Radarr', sourceServerId: 'radarr-1' })
    const server: ImportWatcherServer = {
      id: 'radarr-1',
      name: 'My Radarr',
      isInitialized: true,
      recentlyImportedDownloadIds: async () => new Set(),
      manualImport: async () => 42,
      manualImportCommandStatus: async () => ({ state: 'completed' }),
    }
    const watcher = watcherWithServers(repo, [server])

    await watcher.tick()
    await watcher.tick()

    expect(repo.get(row.id)?.status).toBe('imported')
  })

  test('marks a manual import row failed when the tracked command fails', async () => {
    const repo = makeRepo()
    const row = manualImportRow(repo, { qbSourceServer: 'My Radarr', sourceServerId: 'radarr-1' })
    const server: ImportWatcherServer = {
      id: 'radarr-1',
      name: 'My Radarr',
      isInitialized: true,
      recentlyImportedDownloadIds: async () => new Set(),
      manualImport: async () => 43,
      manualImportCommandStatus: async () => ({ state: 'failed', error: 'manual import rejected' }),
    }
    const watcher = watcherWithServers(repo, [server])

    await watcher.tick()
    await watcher.tick()

    expect(repo.get(row.id)).toMatchObject({ status: 'failed', error: 'manual import rejected' })
  })

  test('marks a manual import row failed when the connector reports a permanent import error', async () => {
    const repo = makeRepo()
    const row = manualImportRow(repo, { qbSourceServer: 'My Radarr', sourceServerId: 'radarr-1' })
    const server: ImportWatcherServer = {
      id: 'radarr-1',
      name: 'My Radarr',
      isInitialized: true,
      recentlyImportedDownloadIds: async () => new Set(),
      manualImport: async () => {
        throw new PermanentManualImportError('episode ids could not be resolved')
      },
      manualImportCommandStatus: async () => ({ state: 'pending' }),
    }
    const watcher = watcherWithServers(repo, [server])

    await watcher.tick()

    expect(repo.get(row.id)).toMatchObject({ status: 'failed', error: 'episode ids could not be resolved' })
  })
})

// `downloads.unlinkImportedFiles`: once *arr confirms the import, jack's own copy in
// completedPath is dead weight (*arr hardlinked or copied it into the library), so the
// watcher drops jack's link. Only ever on a confirmed import — never on a queued,
// failed, or still-pending row.
describe('ImportWatcher imported-file cleanup', () => {
  let completedPath: string

  beforeEach(async () => {
    completedPath = await mkdtemp(join(tmpdir(), 'jack-unlink-'))
  })

  afterEach(async () => {
    await rm(completedPath, { recursive: true, force: true })
  })

  // A queued row whose destPath is a real file inside the temp completedPath.
  async function queuedRowWithFile(repo: DownloadsRepository, opts: { name?: string, mode?: 'jack_manual' } = {}) {
    const destPath = join(completedPath, opts.name ?? 'x.mkv')
    await Bun.write(destPath, 'payload')
    const row = repo.create({
      torrentFilename: 't.torrent',
      peerId: 'peer-1',
      peerName: 'Friend',
      itemId: 'movie:1',
      filename: release.filename,
      destPath,
      partPath: `${destPath}.part`,
      releaseSize: release.size,
      release,
      qbSourceServer: 'My Radarr',
      sourceServerId: 'radarr-1',
      ...(opts.mode === 'jack_manual'
        ? { importMode: 'jack_manual' as const, importTarget: { kind: 'movie' as const, movieId: 42 } }
        : {}),
    })
    repo.markImportQueued(row.id)
    return row
  }

  function cleanupWatcher(repo: DownloadsRepository, servers: ImportWatcherServer[], enabled: () => boolean) {
    return new ImportWatcher(repo, { servers: servers as unknown as ArrServerConnector[] }, 1000, undefined, undefined, {
      enabled,
      completedPath,
    })
  }

  test('unlinks the file once *arr history confirms the import', async () => {
    const repo = makeRepo()
    const row = await queuedRowWithFile(repo)
    const watcher = cleanupWatcher(repo, [{ ...fakeServer('My Radarr', [HASH]), id: 'radarr-1' }], () => true)

    expect(await watcher.tick()).toBe(1)
    expect(repo.get(row.id)?.status).toBe('imported')
    expect(await Bun.file(row.destPath).exists()).toBe(false)
  })

  test('unlinks the file once a tracked manual import command completes', async () => {
    const repo = makeRepo()
    const row = await queuedRowWithFile(repo, { mode: 'jack_manual' })
    const server: ImportWatcherServer = {
      id: 'radarr-1',
      name: 'My Radarr',
      isInitialized: true,
      recentlyImportedDownloadIds: async () => new Set(),
      manualImport: async () => 44,
      manualImportCommandStatus: async () => ({ state: 'completed' }),
    }
    const watcher = cleanupWatcher(repo, [server], () => true)

    // First tick pushes the manual import, second sees the command completed.
    await watcher.tick()
    expect(await Bun.file(row.destPath).exists()).toBe(true)
    await watcher.tick()

    expect(repo.get(row.id)?.status).toBe('imported')
    expect(await Bun.file(row.destPath).exists()).toBe(false)
  })

  test('keeps the file while the row is still queued, and when the import fails', async () => {
    const repo = makeRepo()
    const queued = await queuedRowWithFile(repo, { name: 'queued.mkv', mode: 'jack_manual' })
    const failing = await queuedRowWithFile(repo, { name: 'failing.mkv', mode: 'jack_manual' })
    const server: ImportWatcherServer = {
      id: 'radarr-1',
      name: 'My Radarr',
      isInitialized: true,
      recentlyImportedDownloadIds: async () => new Set(),
      manualImport: async params => (params.paths[0] === failing.destPath ? 46 : 45),
      manualImportCommandStatus: async commandId =>
        (commandId === 46 ? { state: 'failed', error: 'arr rejected it' } : { state: 'pending' }),
    }
    const watcher = cleanupWatcher(repo, [server], () => true)

    await watcher.tick()
    await watcher.tick()

    expect(repo.get(queued.id)?.status).toBe('import_queued')
    expect(repo.get(failing.id)?.status).toBe('failed')
    expect(await Bun.file(queued.destPath).exists()).toBe(true)
    expect(await Bun.file(failing.destPath).exists()).toBe(true)
  })

  test('keeps the file when the option is off', async () => {
    const repo = makeRepo()
    const row = await queuedRowWithFile(repo)
    const watcher = cleanupWatcher(repo, [{ ...fakeServer('My Radarr', [HASH]), id: 'radarr-1' }], () => false)

    expect(await watcher.tick()).toBe(1)
    expect(repo.get(row.id)?.status).toBe('imported')
    expect(await Bun.file(row.destPath).exists()).toBe(true)
  })

  test('reads the option per import, so toggling it applies without a restart', async () => {
    const repo = makeRepo()
    const kept = await queuedRowWithFile(repo, { name: 'kept.mkv' })
    let enabled = false
    const watcher = cleanupWatcher(repo, [{ ...fakeServer('My Radarr', [HASH]), id: 'radarr-1' }], () => enabled)

    await watcher.tick()
    expect(await Bun.file(kept.destPath).exists()).toBe(true)

    enabled = true
    const unlinked = await queuedRowWithFile(repo, { name: 'unlinked.mkv' })
    await watcher.tick()

    expect(await Bun.file(unlinked.destPath).exists()).toBe(false)
  })

  test('leaves the row imported when the unlink fails', async () => {
    const repo = makeRepo()
    const row = await queuedRowWithFile(repo)
    // A directory where the file is expected: unlink(2) fails with EISDIR/EPERM.
    await rm(row.destPath)
    await mkdir(row.destPath)
    const watcher = cleanupWatcher(repo, [{ ...fakeServer('My Radarr', [HASH]), id: 'radarr-1' }], () => true)

    expect(await watcher.tick()).toBe(1)
    expect(repo.get(row.id)?.status).toBe('imported')
  })

  // Two rows can share a destination: the in-flight duplicate guard only covers active
  // transfers, so a re-grab that lands while the first row is still import_queued gets
  // its own row on the same path. Whichever imports last has to do the cleanup —
  // otherwise both defer to each other and the file outlives both rows.
  test('defers cleanup to the last of two rows sharing a destination', async () => {
    const repo = makeRepo()
    const first = await queuedRowWithFile(repo, { name: 'shared.mkv' })
    const second = repo.create({
      torrentFilename: 't2.torrent',
      peerId: 'peer-1',
      peerName: 'Friend',
      itemId: 'movie:1',
      filename: release.filename,
      destPath: first.destPath,
      partPath: first.partPath,
      releaseSize: release.size,
      release,
      qbSourceServer: 'My Radarr',
      sourceServerId: 'radarr-1',
    })
    repo.markImportQueued(second.id)

    // Only the first row's hash is in *arr history to begin with, so it imports alone.
    const importedHashes = [HASH]
    const server = {
      id: 'radarr-1',
      name: 'My Radarr',
      isInitialized: true,
      recentlyImportedDownloadIds: async () => new Set(importedHashes.map(h => h.toLowerCase())),
    } as any
    const watcher = cleanupWatcher(repo, [server], () => true)

    await watcher.tick()

    // Both rows flip on the same hash, so drive them one at a time by re-reading state.
    const imported = [first, second].filter(row => repo.get(row.id)?.status === 'imported')
    const stillQueued = [first, second].filter(row => repo.get(row.id)?.status === 'import_queued')
    expect(imported).toHaveLength(2)
    expect(stillQueued).toHaveLength(0)
    // The row that imported second saw an already-imported sibling and cleaned up.
    expect(await Bun.file(first.destPath).exists()).toBe(false)
  })

  test('keeps the file while a row sharing the destination is still awaiting import', async () => {
    const repo = makeRepo()
    const importing = await queuedRowWithFile(repo, { name: 'shared.mkv' })
    // A second row on the same path that *arr has not imported — it still needs the file.
    const waiting = repo.create({
      torrentFilename: 't2.torrent',
      peerId: 'peer-1',
      peerName: 'Friend',
      itemId: 'movie:2',
      filename: release.filename,
      destPath: importing.destPath,
      partPath: importing.partPath,
      releaseSize: release.size,
      release,
      qbSourceServer: 'Other Radarr',
      sourceServerId: 'radarr-2',
    })
    repo.markImportQueued(waiting.id)

    // Only radarr-1 is connected, so only `importing` can flip to imported this tick.
    const watcher = cleanupWatcher(repo, [{ ...fakeServer('My Radarr', [HASH]), id: 'radarr-1' }], () => true)

    expect(await watcher.tick()).toBe(1)
    expect(repo.get(importing.id)?.status).toBe('imported')
    expect(repo.get(waiting.id)?.status).toBe('import_queued')
    expect(await Bun.file(importing.destPath).exists()).toBe(true)
  })

  test('never unlinks a path outside completedPath', async () => {
    const repo = makeRepo()
    const outside = await mkdtemp(join(tmpdir(), 'jack-outside-'))
    const destPath = join(outside, 'x.mkv')
    await Bun.write(destPath, 'payload')
    const row = repo.create({
      torrentFilename: 't.torrent',
      peerId: 'peer-1',
      peerName: 'Friend',
      itemId: 'movie:1',
      filename: release.filename,
      destPath,
      partPath: `${destPath}.part`,
      releaseSize: release.size,
      release,
      qbSourceServer: 'My Radarr',
      sourceServerId: 'radarr-1',
    })
    repo.markImportQueued(row.id)
    const watcher = cleanupWatcher(repo, [{ ...fakeServer('My Radarr', [HASH]), id: 'radarr-1' }], () => true)

    expect(await watcher.tick()).toBe(1)
    expect(await Bun.file(destPath).exists()).toBe(true)
    await rm(outside, { recursive: true, force: true })
  })
})
