import type { Release } from '../lib/release'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { openDatabase } from '../database/connection'
import { FetchError } from '../lib/errors/FetchError'
import { DownloadsRepository } from '../modules/downloads/downloads.repository'
import { DownloadsService } from '../modules/downloads/downloads.service'
import { createTorrentStub } from '../modules/torznab/torrent'

const release: Release = {
  id: 'remote:movie:1',
  title: 'Movie.2024.1080p',
  filename: 'Movie.2024.1080p.mkv',
  category: 2000,
  size: 10,
}

let tempDir: string
let watchPath: string
let completedPath: string

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'jack-downloads-service-'))
  watchPath = join(tempDir, 'watch')
  completedPath = join(tempDir, 'completed')
  await Bun.$`mkdir -p ${watchPath} ${completedPath}`.quiet()
})

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true })
})

function downloadsConfig(overrides: Partial<Record<string, number>> = {}) {
  return {
    watchPath,
    completedPath,
    maxConcurrentDownloads: 2,
    maxDownloadAttempts: 3,
    retryBaseDelayMs: 0,
    retryMaxDelayMs: 0,
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

function fakeDestination() {
  return { isInitialized: true, canDestination: true, name: 'Radarr', categories: [2000], triggerImport: async () => {} }
}

async function writeTorrent(filename = 'movie.torrent', itemId = 'movie:1') {
  const filePath = join(watchPath, filename)
  await writeFile(filePath, createTorrentStub({ name: release.title, size: release.size, peerId: 'peer-1', itemId }))
  return filePath
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
    const service = new DownloadsService(downloadsConfig(), [peer as any], [fakeDestination() as any], repository)
    const filePath = await writeTorrent()

    await service.processTorrentFile(filePath, 'movie.torrent')

    expect(calls).toHaveLength(1)
    expect(calls[0].destPath).toBe(join(completedPath, release.filename))
    expect(calls[0].options.partPath).toBe(`${join(completedPath, release.filename)}.part`)
    expect(calls[0].options.releaseSize).toBe(10)
    expect(calls[0].options.torrentFilename).toBe('movie.torrent')

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
    const service = new DownloadsService(downloadsConfig(), [peer as any], [], repository)
    const filePath = await writeTorrent()

    await service.processTorrentFile(filePath, 'movie.torrent')

    expect(repository.list()).toHaveLength(0)
    handle.close()
  })

  test('rejects a peer release with a path-traversal filename', async () => {
    const handle = await openDatabase({ appConfigPath: join(tempDir, 'config.jsonc') })
    const repository = new DownloadsRepository(handle.db)
    const writtenPaths: string[] = []
    const peer = fakePeer({
      getRelease: async () => ({ ...release, filename: '../../evil.mkv' }),
      downloadFile: async (_itemId: string, destPath: string) => {
        writtenPaths.push(destPath)
      },
    })
    const service = new DownloadsService(downloadsConfig(), [peer as any], [fakeDestination() as any], repository)
    const filePath = await writeTorrent()

    await service.processTorrentFile(filePath, 'movie.torrent')

    expect(writtenPaths).toHaveLength(0)
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
    const service = new DownloadsService(downloadsConfig(), [peer as any], [], repository)
    const filePath = await writeTorrent()

    await service.processTorrentFile(filePath, 'movie.torrent')

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
    const service = new DownloadsService(downloadsConfig(), [peer as any], [fakeDestination() as any], repository)
    const filePath = await writeTorrent()

    await service.processTorrentFile(filePath, 'movie.torrent')

    expect(calls).toBe(2)
    const downloads = repository.list()
    expect(downloads[0]?.status).toBe('import_queued')
    expect(downloads[0]?.attempts).toBe(2)
    handle.close()
  })

  test('persists a resume reset from a restart event', async () => {
    const handle = await openDatabase({ appConfigPath: join(tempDir, 'config.jsonc') })
    const repository = new DownloadsRepository(handle.db)
    // Spy, because a realistic download ends with a `completed` event whose
    // markCompleted() clears the error markResumeReset() set — so asserting the
    // final row state cannot prove the reset ran.
    const resetSpy = spyOn(repository, 'markResumeReset')
    const peer = fakePeer({
      downloadFile: async (_itemId: string, _destPath: string, options: any) => {
        await options.onProgress({ type: 'headers', expectedBytes: 10, expectedBytesSource: 'content_length', expectedBytesMismatch: false })
        await options.onProgress({ type: 'restart', reason: 'range_ignored', discardedBytes: 4 })
        await options.onProgress({ type: 'completed', downloadedBytes: 10, expectedBytes: 10 })
      },
    })
    const service = new DownloadsService(downloadsConfig(), [peer as any], [fakeDestination() as any], repository)
    const filePath = await writeTorrent()

    await service.processTorrentFile(filePath, 'movie.torrent')

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
    const service = new DownloadsService(downloadsConfig({ maxConcurrentDownloads: 1 }), [peer as any], [fakeDestination() as any], repository)
    const a = await writeTorrent('a.torrent', 'movie:1')
    const b = await writeTorrent('b.torrent', 'movie:2')

    await Promise.all([
      service.processTorrentFile(a, 'a.torrent'),
      service.processTorrentFile(b, 'b.torrent'),
    ])

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
    const service = new DownloadsService(downloadsConfig(), [peer as any], [fakeDestination() as any], repository)

    const resumed = await service.resumeStaleDownloads()
    // resumeStaleDownloads fires in the background; wait for the row to settle.
    for (let i = 0; i < 50 && repository.list()[0]?.status !== 'import_queued'; i++)
      await Bun.sleep(10)

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
    const service = new DownloadsService(downloadsConfig(), [peer as any], [fakeDestination() as any], repository)

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

  test('releases the re-enqueue claim after a successful resume so the filename can be processed again', async () => {
    const handle = await openDatabase({ appConfigPath: join(tempDir, 'config.jsonc') })
    const repository = new DownloadsRepository(handle.db)
    const calls: string[] = []
    const peer = fakePeer({
      downloadFile: async (itemId: string, _destPath: string, options: any) => {
        calls.push(itemId)
        await options.onProgress({ type: 'completed', downloadedBytes: 10, expectedBytes: 10 })
      },
    })
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
    const service = new DownloadsService(downloadsConfig(), [peer as any], [fakeDestination() as any], repository)

    await service.resumeStaleDownloads()
    for (let i = 0; i < 50 && repository.list()[0]?.status !== 'import_queued'; i++)
      await Bun.sleep(10)
    expect(calls).toHaveLength(1)

    // A later legitimate re-drop of the same torrent filename must NOT be skipped
    // by a stale re-enqueue claim once the resume has completed.
    const filePath = await writeTorrent('movie.torrent')
    await service.processTorrentFile(filePath, 'movie.torrent')

    expect(calls).toHaveLength(2)
    expect(repository.list().filter(d => d.status === 'import_queued')).toHaveLength(2)
    handle.close()
  })

  test('only triggers import on destinations whose categories match the release', async () => {
    const handle = await openDatabase({ appConfigPath: join(tempDir, 'config.jsonc') })
    const repository = new DownloadsRepository(handle.db)
    const triggered: string[] = []
    function dest(name: string, categories: number[]) {
      return {
        isInitialized: true,
        canDestination: true,
        name,
        categories,
        triggerImport: async () => {
          triggered.push(name)
        },
      }
    }
    // release is a movie (category 2000) — only Radarr should be scanned, not Sonarr.
    const radarr = dest('Radarr', [2000])
    const sonarr = dest('Sonarr', [5000])
    const service = new DownloadsService(downloadsConfig(), [fakePeer() as any], [radarr, sonarr] as any, repository)
    const filePath = await writeTorrent()

    await service.processTorrentFile(filePath, 'movie.torrent')

    expect(triggered).toEqual(['Radarr'])
    expect(repository.list()[0]?.status).toBe('import_queued')
    handle.close()
  })
})
