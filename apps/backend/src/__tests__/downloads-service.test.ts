import type { Release } from '../lib/release'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { openDatabase } from '../database/connection'
import { FetchError } from '../lib/errors/FetchError'
import { DownloadsRepository } from '../modules/downloads/downloads.repository'
import { DownloadsService } from '../modules/downloads/downloads.service'

const release: Release = {
  id: 'remote:movie:1',
  title: 'Movie.2024.1080p',
  filename: 'Movie.2024.1080p.mkv',
  category: 2000,
  size: 10,
}

let tempDir: string
let completedPath: string

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'jack-downloads-service-'))
  completedPath = join(tempDir, 'completed')
  await Bun.$`mkdir -p ${completedPath}`.quiet()
})

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true })
})

function downloadsConfig(overrides: Partial<Record<string, number>> = {}) {
  return {
    completedPath,
    maxConcurrentDownloads: 2,
    maxDownloadAttempts: 3,
    retryBaseDelayMs: 0,
    retryMaxDelayMs: 0,
    idleTimeoutMs: 60_000,
    importPollIntervalMs: 30_000,
    ...overrides,
  }
}

function fakePeer(overrides: Partial<Record<'getRelease' | 'downloadFile', any>> = {}) {
  return {
    id: 'peer-1',
    name: 'Friend Jack',
    url: 'http://peer.test',
    getRelease: overrides.getRelease ?? (async () => release),
    downloadFile: overrides.downloadFile ?? (async (_itemId: string, _destPath: string, options: any) => {
      await options.onProgress({ type: 'headers', expectedBytes: 10, expectedBytesSource: 'content_length', expectedBytesMismatch: false })
      await options.onProgress({ type: 'progress', downloadedBytes: 4, expectedBytes: 10 })
      await options.onProgress({ type: 'completed', downloadedBytes: 10, expectedBytes: 10 })
    }),
  }
}

// Poll until the (single) row reaches a terminal status, or the timeout elapses.
async function waitForStatus(repository: DownloadsRepository, status: string) {
  for (let i = 0; i < 50 && repository.list()[0]?.status !== status; i++)
    await Bun.sleep(10)
}

describe('DownloadsService download progress persistence', () => {
  test('creates a row only after release metadata resolves and moves it to import_queued', async () => {
    const handle = await openDatabase({ appConfigPath: join(tempDir, 'config.jsonc') })
    const repository = new DownloadsRepository(handle.db)
    const calls: any[] = []
    const peer = fakePeer({
      downloadFile: async (itemId: string, destPath: string, options: any) => {
        calls.push({ itemId, destPath, options })
        await options.onProgress({ type: 'headers', expectedBytes: 10, expectedBytesSource: 'content_length', expectedBytesMismatch: false })
        await options.onProgress({ type: 'progress', downloadedBytes: 4, expectedBytes: 10 })
        await options.onProgress({ type: 'completed', downloadedBytes: 10, expectedBytes: 10 })
      },
    })
    const service = new DownloadsService(downloadsConfig(), { peers: [peer as any] }, repository)

    await service.startQbDownload({ peerId: 'peer-1', itemId: 'movie:1', qbCategory: 'jack-x', qbSourceServer: 'My Radarr' })
    await waitForStatus(repository, 'import_queued')

    expect(calls).toHaveLength(1)
    expect(calls[0].destPath).toBe(join(completedPath, release.filename))
    expect(calls[0].options.partPath).toBe(`${join(completedPath, release.filename)}.part`)
    expect(calls[0].options.releaseSize).toBe(10)

    const downloads = repository.list()
    expect(downloads).toHaveLength(1)
    expect(downloads[0]?.status).toBe('import_queued')
    expect(downloads[0]?.downloadedBytes).toBe(10)
    expect(downloads[0]?.attempts).toBe(1)
    handle.close()
  })

  test('does not create a row when release metadata lookup fails', async () => {
    const handle = await openDatabase({ appConfigPath: join(tempDir, 'config.jsonc') })
    const repository = new DownloadsRepository(handle.db)
    const peer = fakePeer({ getRelease: async () => {
      throw new Error('metadata failed')
    } })
    const service = new DownloadsService(downloadsConfig(), { peers: [peer as any] }, repository)

    const result = await service.startQbDownload({ peerId: 'peer-1', itemId: 'movie:1', qbCategory: 'jack-x', qbSourceServer: 'My Radarr' })

    expect(result).toBe('failed')
    expect(repository.list()).toHaveLength(0)
    handle.close()
  })

  test('marks an existing row failed when a permanent download error occurs', async () => {
    const handle = await openDatabase({ appConfigPath: join(tempDir, 'config.jsonc') })
    const repository = new DownloadsRepository(handle.db)
    let calls = 0
    const peer = fakePeer({ downloadFile: async () => {
      calls++
      throw new FetchError('not found', new Response(null, { status: 404 }))
    } })
    const service = new DownloadsService(downloadsConfig(), { peers: [peer as any] }, repository)

    await service.startQbDownload({ peerId: 'peer-1', itemId: 'movie:1', qbCategory: 'jack-x', qbSourceServer: 'My Radarr' })
    await waitForStatus(repository, 'failed')

    expect(calls).toBe(1) // 404 is permanent — no retry
    const downloads = repository.list()
    expect(downloads[0]?.status).toBe('failed')
    handle.close()
  })

  test('retries a transient failure then succeeds', async () => {
    const handle = await openDatabase({ appConfigPath: join(tempDir, 'config.jsonc') })
    const repository = new DownloadsRepository(handle.db)
    let calls = 0
    const peer = fakePeer({
      downloadFile: async (_itemId: string, _destPath: string, options: any) => {
        calls++
        if (calls === 1)
          throw new FetchError('busy', new Response(null, { status: 503 }))
        await options.onProgress({ type: 'completed', downloadedBytes: 10, expectedBytes: 10 })
      },
    })
    const service = new DownloadsService(downloadsConfig(), { peers: [peer as any] }, repository)

    await service.startQbDownload({ peerId: 'peer-1', itemId: 'movie:1', qbCategory: 'jack-x', qbSourceServer: 'My Radarr' })
    await waitForStatus(repository, 'import_queued')

    expect(calls).toBe(2)
    const downloads = repository.list()
    expect(downloads[0]?.status).toBe('import_queued')
    expect(downloads[0]?.attempts).toBe(2)
    handle.close()
  })

  test('persists a resume reset from a restart event', async () => {
    const handle = await openDatabase({ appConfigPath: join(tempDir, 'config.jsonc') })
    const repository = new DownloadsRepository(handle.db)
    // Spy, because a realistic download ends by moving to import_queued, which
    // clears the error markResumeReset() set — so asserting the final row state
    // cannot prove the reset ran.
    const resetSpy = spyOn(repository, 'markResumeReset')
    const peer = fakePeer({
      downloadFile: async (_itemId: string, _destPath: string, options: any) => {
        await options.onProgress({ type: 'headers', expectedBytes: 10, expectedBytesSource: 'content_length', expectedBytesMismatch: false })
        await options.onProgress({ type: 'restart', reason: 'range_ignored', discardedBytes: 4 })
        await options.onProgress({ type: 'completed', downloadedBytes: 10, expectedBytes: 10 })
      },
    })
    const service = new DownloadsService(downloadsConfig(), { peers: [peer as any] }, repository)

    await service.startQbDownload({ peerId: 'peer-1', itemId: 'movie:1', qbCategory: 'jack-x', qbSourceServer: 'My Radarr' })
    await waitForStatus(repository, 'import_queued')

    expect(resetSpy).toHaveBeenCalledTimes(1)
    expect(repository.list()[0]?.status).toBe('import_queued')
    resetSpy.mockRestore()
    handle.close()
  })

  test('limits concurrent downloads to maxConcurrentDownloads', async () => {
    const handle = await openDatabase({ appConfigPath: join(tempDir, 'config.jsonc') })
    const repository = new DownloadsRepository(handle.db)
    let active = 0
    let maxActive = 0
    const peer = {
      id: 'peer-1',
      name: 'Friend Jack',
      url: 'http://peer.test',
      // Distinct filename per item so each maps to a distinct destPath.
      getRelease: async (itemId: string) => ({ ...release, id: `remote:${itemId}`, filename: `${itemId.replace(':', '_')}.mkv` }),
      downloadFile: async (_itemId: string, _destPath: string, options: any) => {
        active++
        maxActive = Math.max(maxActive, active)
        await Bun.sleep(20)
        active--
        await options.onProgress({ type: 'completed', downloadedBytes: 10, expectedBytes: 10 })
      },
    }
    const service = new DownloadsService(downloadsConfig({ maxConcurrentDownloads: 1 }), { peers: [peer as any] }, repository)

    await service.startQbDownload({ peerId: 'peer-1', itemId: 'movie:1', qbCategory: 'jack-x', qbSourceServer: 'My Radarr' })
    await service.startQbDownload({ peerId: 'peer-1', itemId: 'movie:2', qbCategory: 'jack-x', qbSourceServer: 'My Radarr' })
    for (let i = 0; i < 100 && repository.list().filter(d => d.status === 'import_queued').length < 2; i++)
      await Bun.sleep(10)

    expect(maxActive).toBe(1)
    expect(repository.list().filter(d => d.status === 'import_queued')).toHaveLength(2)
    handle.close()
  })

  test('resumeStaleDownloads re-drives a stale downloading row to import_queued', async () => {
    const handle = await openDatabase({ appConfigPath: join(tempDir, 'config.jsonc') })
    const repository = new DownloadsRepository(handle.db)
    const calls: string[] = []
    const peer = fakePeer({
      downloadFile: async (_itemId: string, destPath: string, options: any) => {
        calls.push(destPath)
        await options.onProgress({ type: 'completed', downloadedBytes: 10, expectedBytes: 10 })
      },
    })
    // Seed a stale `downloading` row, as if Jack crashed mid-download.
    repository.create({
      torrentFilename: 'movie.torrent',
      peerId: 'peer-1',
      peerName: 'Friend Jack',
      itemId: 'movie:1',
      filename: release.filename,
      destPath: join(completedPath, release.filename),
      partPath: `${join(completedPath, release.filename)}.part`,
      releaseSize: release.size,
      release,
    })
    const service = new DownloadsService(downloadsConfig(), { peers: [peer as any] }, repository)

    const resumed = await service.resumeStaleDownloads()
    // resumeStaleDownloads fires in the background; wait for the row to settle.
    await waitForStatus(repository, 'import_queued')

    expect(resumed).toBe(1)
    expect(calls).toEqual([join(completedPath, release.filename)])
    expect(repository.list()[0]?.status).toBe('import_queued')
    handle.close()
  })

  test('marks superseded duplicate stale rows (same destPath) failed and re-drives only one', async () => {
    const handle = await openDatabase({ appConfigPath: join(tempDir, 'config.jsonc') })
    const repository = new DownloadsRepository(handle.db)
    const calls: string[] = []
    const peer = fakePeer({
      downloadFile: async (_itemId: string, destPath: string, options: any) => {
        calls.push(destPath)
        await options.onProgress({ type: 'completed', downloadedBytes: 10, expectedBytes: 10 })
      },
    })
    const destPath = join(completedPath, release.filename)
    const base = {
      peerId: 'peer-1',
      peerName: 'Friend Jack',
      itemId: 'movie:1',
      filename: release.filename,
      destPath,
      partPath: `${destPath}.part`,
      releaseSize: release.size,
      release,
    }
    repository.create({ ...base, torrentFilename: 'first.torrent' })
    repository.create({ ...base, torrentFilename: 'second.torrent' })
    const service = new DownloadsService(downloadsConfig(), { peers: [peer as any] }, repository)

    const resumed = await service.resumeStaleDownloads()
    for (let i = 0; i < 50 && !repository.list().some(d => d.status === 'import_queued'); i++)
      await Bun.sleep(10)

    expect(resumed).toBe(1)
    expect(calls).toEqual([destPath]) // only one of the two same-destPath rows is re-driven
    const rows = repository.list()
    expect(rows.filter(d => d.status === 'import_queued')).toHaveLength(1)
    expect(rows.find(d => d.status === 'failed')?.error).toContain('superseded')
    handle.close()
  })

  test('startQbDownload creates a row with qb fields and ends import_queued', async () => {
    const handle = await openDatabase({ appConfigPath: join(tempDir, 'config.jsonc') })
    const repository = new DownloadsRepository(handle.db)
    const service = new DownloadsService(downloadsConfig(), { peers: [fakePeer() as any] }, repository)

    const result = await service.startQbDownload({
      peerId: 'peer-1',
      itemId: 'movie:1',
      qbCategory: 'jack-x',
      qbSourceServer: 'My Radarr',
    })

    expect(result).toBe('started')
    await waitForStatus(repository, 'import_queued')

    const rows = repository.list()
    expect(rows).toHaveLength(1)
    expect(rows[0]?.status).toBe('import_queued')
    expect(rows[0]?.qbCategory).toBe('jack-x')
    expect(rows[0]?.qbSourceServer).toBe('My Radarr')
    handle.close()
  })

  test('startQbDownload returns failed when the release filename is unsafe', async () => {
    const handle = await openDatabase({ appConfigPath: join(tempDir, 'config.jsonc') })
    const repository = new DownloadsRepository(handle.db)
    const peer = fakePeer({ getRelease: async () => ({ ...release, filename: '../../evil.mkv' }) })
    const service = new DownloadsService(downloadsConfig(), { peers: [peer as any] }, repository)

    const result = await service.startQbDownload({
      peerId: 'peer-1',
      itemId: 'movie:1',
      qbCategory: 'jack-x',
      qbSourceServer: 'My Radarr',
    })

    expect(result).toBe('failed')
    expect(repository.list()).toHaveLength(0)
    handle.close()
  })

  test('startDirectDownload creates a jack_manual row carrying the importTarget and ends import_queued', async () => {
    const handle = await openDatabase({ appConfigPath: join(tempDir, 'config.jsonc') })
    const repository = new DownloadsRepository(handle.db)
    const service = new DownloadsService(downloadsConfig(), { peers: [fakePeer() as any] }, repository)

    const result = await service.startDirectDownload({
      peerId: 'peer-1',
      itemId: 'movie:1',
      destinationServerName: 'My Radarr',
      importTarget: { kind: 'movie', movieId: 42 },
    })

    expect(result).toBe('started')
    await waitForStatus(repository, 'import_queued')

    const rows = repository.list()
    expect(rows).toHaveLength(1)
    expect(rows[0]?.status).toBe('import_queued')
    expect(rows[0]?.qbSourceServer).toBe('My Radarr')
    expect(rows[0]?.importMode).toBe('jack_manual')
    expect(rows[0]?.importTarget).toEqual({ kind: 'movie', movieId: 42 })
    handle.close()
  })
})
