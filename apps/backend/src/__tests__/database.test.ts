import type { Release } from '../lib/release'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { getDatabasePath, openDatabase } from '../database/connection'
import { DownloadsRepository } from '../modules/downloads/downloads.repository'

let tempDir: string

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'jack-database-'))
})

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true })
})

describe('database connection', () => {
  test('places database.sqlite next to config.jsonc', () => {
    expect(getDatabasePath('/config/config.jsonc')).toBe('/config/database.sqlite')
    expect(getDatabasePath(join(tempDir, 'config.jsonc'))).toBe(join(tempDir, 'database.sqlite'))
  })

  test('creates the downloads table and persists data across reopen', async () => {
    const configPath = join(tempDir, 'config.jsonc')
    const first = await openDatabase({ appConfigPath: configPath })
    first.sqlite.exec(`
      insert into downloads (
        torrent_filename, peer_id, peer_name, item_id, filename, dest_path, part_path,
        release_size, release_json, downloaded_bytes, status, started_at, updated_at
      ) values (
        'movie.torrent', 'peer-1', 'Friend Jack', 'movie:1', 'Movie.mkv',
        '/complete/Movie.mkv', '/complete/Movie.mkv.part', 10, '{}', 0,
        'downloading', '2026-06-04T00:00:00.000Z', '2026-06-04T00:00:00.000Z'
      )
    `)
    first.close()

    const second = await openDatabase({ appConfigPath: configPath })
    const row = second.sqlite.query('select torrent_filename from downloads').get() as { torrent_filename: string }
    expect(row.torrent_filename).toBe('movie.torrent')
    second.close()
  })
})

const release: Release = {
  id: 'remote:movie:1',
  title: 'Movie.2024.1080p',
  filename: 'Movie.2024.1080p.mkv',
  category: 2000,
  size: 100,
  imdbId: 'tt1234567',
  tmdbId: 123,
  quality: { name: 'Bluray-1080p', source: 'bluray', resolution: 1080 },
}

describe('DownloadsRepository', () => {
  test('creates rows after release metadata is available and lists newest first', async () => {
    const handle = await openDatabase({ appConfigPath: join(tempDir, 'config.jsonc') })
    const repository = new DownloadsRepository(handle.db)

    const first = repository.create({
      torrentFilename: 'first.torrent',
      peerId: 'peer-1',
      peerName: 'Friend Jack',
      itemId: 'movie:1',
      filename: release.filename,
      destPath: join(tempDir, release.filename),
      partPath: join(tempDir, `${release.filename}.part`),
      releaseSize: release.size,
      release,
    })

    const second = repository.create({
      torrentFilename: 'second.torrent',
      peerId: 'peer-1',
      peerName: 'Friend Jack',
      itemId: 'movie:2',
      filename: 'Second.mkv',
      destPath: join(tempDir, 'Second.mkv'),
      partPath: join(tempDir, 'Second.mkv.part'),
      releaseSize: 200,
      release: { ...release, id: 'remote:movie:2', filename: 'Second.mkv', size: 200 },
    })

    expect(first.status).toBe('downloading')
    expect(repository.list()[0]?.id).toBe(second.id)
    expect(repository.get(first.id)?.release.title).toBe('Movie.2024.1080p')
    handle.close()
  })

  test('updates expected bytes, progress, completion, import queue, and failure', async () => {
    const handle = await openDatabase({ appConfigPath: join(tempDir, 'config.jsonc') })
    const repository = new DownloadsRepository(handle.db)
    const created = repository.create({
      torrentFilename: 'movie.torrent',
      peerId: 'peer-1',
      peerName: 'Friend Jack',
      itemId: 'movie:1',
      filename: release.filename,
      destPath: join(tempDir, release.filename),
      partPath: join(tempDir, `${release.filename}.part`),
      releaseSize: release.size,
      release,
    })

    repository.setExpectedBytes(created.id, 120, 'content_length', true)
    repository.updateProgress(created.id, 40)
    repository.markCompleted(created.id, 120)
    repository.markImportQueued(created.id)

    const done = repository.get(created.id)!
    expect(done.expectedBytes).toBe(120)
    expect(done.expectedBytesSource).toBe('content_length')
    expect(done.expectedBytesMismatch).toBe(true)
    expect(done.downloadedBytes).toBe(120)
    expect(done.status).toBe('import_queued')
    expect(typeof done.completedAt).toBe('string')

    repository.markFailed(created.id, 'import failed after queue')
    const failed = repository.get(created.id)!
    expect(failed.status).toBe('failed')
    expect(failed.error).toBe('import failed after queue')
    handle.close()
  })

  test('reconciles stale downloading rows using .part file size', async () => {
    const handle = await openDatabase({ appConfigPath: join(tempDir, 'config.jsonc') })
    const repository = new DownloadsRepository(handle.db)
    const partPath = join(tempDir, 'Movie.mkv.part')
    await writeFile(partPath, new Uint8Array([1, 2, 3, 4]))

    const created = repository.create({
      torrentFilename: 'movie.torrent',
      peerId: 'peer-1',
      peerName: 'Friend Jack',
      itemId: 'movie:1',
      filename: release.filename,
      destPath: join(tempDir, release.filename),
      partPath,
      releaseSize: release.size,
      release,
    })

    const reconciled = await repository.reconcileStaleDownloads()
    const stale = repository.get(created.id)!
    expect(reconciled).toBe(1)
    expect(stale.status).toBe('failed')
    expect(stale.downloadedBytes).toBe(4)
    expect(stale.error).toContain('stale')
    handle.close()
  })

  test('increments attempts and records a resume reset', async () => {
    const handle = await openDatabase({ appConfigPath: join(tempDir, 'config.jsonc') })
    const repository = new DownloadsRepository(handle.db)
    const created = repository.create({
      torrentFilename: 'movie.torrent',
      peerId: 'peer-1',
      peerName: 'Friend Jack',
      itemId: 'movie:1',
      filename: release.filename,
      destPath: join(tempDir, release.filename),
      partPath: join(tempDir, `${release.filename}.part`),
      releaseSize: release.size,
      release,
    })

    expect(repository.incrementAttempts(created.id)).toBe(1)
    expect(repository.incrementAttempts(created.id)).toBe(2)
    repository.updateProgress(created.id, 40)
    repository.markResumeReset(created.id)

    const row = repository.get(created.id)!
    expect(row.attempts).toBe(2)
    expect(row.downloadedBytes).toBe(0)
    expect(row.status).toBe('downloading')
    expect(row.error).toContain('resume validation failed')
    handle.close()
  })

  test('lists stale downloading rows without mutating them', async () => {
    const handle = await openDatabase({ appConfigPath: join(tempDir, 'config.jsonc') })
    const repository = new DownloadsRepository(handle.db)
    const a = repository.create({
      torrentFilename: 'a.torrent',
      peerId: 'peer-1',
      peerName: 'Friend Jack',
      itemId: 'movie:1',
      filename: 'A.mkv',
      destPath: join(tempDir, 'A.mkv'),
      partPath: join(tempDir, 'A.mkv.part'),
      releaseSize: 10,
      release,
    })
    const b = repository.create({
      torrentFilename: 'b.torrent',
      peerId: 'peer-1',
      peerName: 'Friend Jack',
      itemId: 'movie:2',
      filename: 'B.mkv',
      destPath: join(tempDir, 'B.mkv'),
      partPath: join(tempDir, 'B.mkv.part'),
      releaseSize: 10,
      release,
    })
    repository.markCompleted(b.id, 10)

    const stale = repository.listStaleDownloads()
    expect(stale.map(r => r.id)).toEqual([a.id])
    expect(repository.get(a.id)?.status).toBe('downloading')
    handle.close()
  })
})
