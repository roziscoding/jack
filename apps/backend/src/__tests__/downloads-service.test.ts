import type { Release } from '../lib/release'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { openDatabase } from '../database/connection'
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
  return { isInitialized: true, canDestination: true, name: 'Radarr', triggerImport: async () => {} }
}

async function writeTorrent(filename = 'movie.torrent') {
  const filePath = join(watchPath, filename)
  await writeFile(filePath, createTorrentStub({ name: release.title, size: release.size, peerId: 'peer-1', itemId: 'movie:1' }))
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
    const service = new DownloadsService({ completedPath }, [peer as any], [fakeDestination() as any], repository)
    const filePath = await writeTorrent()

    await service.processTorrentFile(filePath, 'movie.torrent')

    // The service forwards dest/part/size/torrentFilename into downloadFile.
    expect(calls).toHaveLength(1)
    expect(calls[0].destPath).toBe(join(completedPath, release.filename))
    expect(calls[0].options.partPath).toBe(`${join(completedPath, release.filename)}.part`)
    expect(calls[0].options.releaseSize).toBe(10)
    expect(calls[0].options.torrentFilename).toBe('movie.torrent')

    const downloads = repository.list()
    expect(downloads).toHaveLength(1)
    expect(downloads[0]?.torrentFilename).toBe('movie.torrent')
    expect(downloads[0]?.filename).toBe(release.filename)
    expect(downloads[0]?.destPath).toBe(join(completedPath, release.filename))
    expect(downloads[0]?.partPath).toBe(`${join(completedPath, release.filename)}.part`)
    expect(downloads[0]?.releaseSize).toBe(10)
    expect(downloads[0]?.expectedBytes).toBe(10)
    expect(downloads[0]?.downloadedBytes).toBe(10)
    expect(downloads[0]?.status).toBe('import_queued')
    handle.close()
  })

  test('does not create a row when release metadata lookup fails', async () => {
    const handle = await openDatabase({ appConfigPath: join(tempDir, 'config.jsonc') })
    const repository = new DownloadsRepository(handle.db)
    const peer = fakePeer({ getRelease: async () => {
      throw new Error('metadata failed')
    } })
    const service = new DownloadsService({ completedPath }, [peer as any], [], repository)
    const filePath = await writeTorrent()

    await service.processTorrentFile(filePath, 'movie.torrent')

    expect(repository.list()).toHaveLength(0)
    handle.close()
  })

  test('rejects a peer release with a path-traversal filename and does not write outside completedPath', async () => {
    const handle = await openDatabase({ appConfigPath: join(tempDir, 'config.jsonc') })
    const repository = new DownloadsRepository(handle.db)
    const writtenPaths: string[] = []
    const peer = fakePeer({
      getRelease: async () => ({ ...release, filename: '../../evil.mkv' }),
      downloadFile: async (_itemId: string, destPath: string) => {
        writtenPaths.push(destPath)
      },
    })
    const service = new DownloadsService({ completedPath }, [peer as any], [fakeDestination() as any], repository)
    const filePath = await writeTorrent()

    await service.processTorrentFile(filePath, 'movie.torrent')

    // The unsafe name must never reach downloadFile / be written to disk.
    expect(writtenPaths).toHaveLength(0)
    const evilOutside = join(tempDir, 'evil.mkv')
    expect(await Bun.file(evilOutside).exists()).toBe(false)
    expect(await Bun.file(`${evilOutside}.part`).exists()).toBe(false)

    const downloads = repository.list()
    expect(downloads).toHaveLength(1)
    expect(downloads[0]?.status).toBe('failed')
    handle.close()
  })

  test('marks an existing row failed when download fails after metadata resolves', async () => {
    const handle = await openDatabase({ appConfigPath: join(tempDir, 'config.jsonc') })
    const repository = new DownloadsRepository(handle.db)
    const peer = fakePeer({ downloadFile: async () => {
      throw new Error('download failed')
    } })
    const service = new DownloadsService({ completedPath }, [peer as any], [], repository)
    const filePath = await writeTorrent()

    await service.processTorrentFile(filePath, 'movie.torrent')

    const downloads = repository.list()
    expect(downloads).toHaveLength(1)
    expect(downloads[0]?.status).toBe('failed')
    expect(downloads[0]?.error).toContain('download failed')
    handle.close()
  })
})
