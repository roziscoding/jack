import type { DownloadRecord } from '../modules/downloads/downloads.repository'
import { describe, expect, test } from 'bun:test'
import { deriveHash, toQbTorrent } from '../modules/qbittorrent/qbittorrent.mapper'

function baseRecord(overrides: Partial<DownloadRecord> = {}): DownloadRecord {
  return {
    id: 1,
    torrentFilename: 'movie.torrent',
    peerId: 'peer0001',
    peerName: 'Peer',
    itemId: 'conn:movie:42',
    filename: 'Big Buck Bunny (2008).mkv',
    destPath: '/tmp/completed/Big Buck Bunny (2008).mkv',
    partPath: '/tmp/completed/Big Buck Bunny (2008).mkv.part',
    releaseSize: 10,
    release: { id: 'conn:movie:42', title: 'Big Buck Bunny', filename: 'Big Buck Bunny (2008).mkv', category: 2000, size: 10 } as any,
    expectedBytes: null,
    expectedBytesSource: null,
    expectedBytesMismatch: false,
    downloadedBytes: 0,
    attempts: 0,
    status: 'downloading',
    startedAt: '2026-06-06T00:00:00.000Z',
    updatedAt: '2026-06-06T00:00:00.000Z',
    completedAt: null,
    error: null,
    qbCategory: 'jack-abc12345',
    qbSourceServer: 'My Radarr',
    sourceServerId: 'abc12345',
    importMode: null,
    importTarget: null,
    manualImportCommandId: null,
    ...overrides,
  }
}

describe('toQbTorrent', () => {
  test('downloading: progress, eta, amount_left from bytes', () => {
    const record = baseRecord({ status: 'downloading', downloadedBytes: 4, expectedBytes: 10 })
    const torrent = toQbTorrent(record, { completedPath: '/tmp/completed', category: 'jack-abc12345' })
    expect(torrent.state).toBe('downloading')
    expect(torrent.progress).toBe(0.4)
    expect(torrent.eta).toBe(8_640_000)
    expect(torrent.amount_left).toBe(6)
  })

  test('import_queued: finished torrent uses pausedUP, full progress, content_path != save_path', () => {
    const record = baseRecord({ status: 'import_queued', downloadedBytes: 10 })
    const torrent = toQbTorrent(record, { completedPath: '/tmp/completed', category: 'jack-abc12345' })
    expect(torrent.state).toBe('pausedUP')
    expect(torrent.progress).toBe(1)
    expect(torrent.amount_left).toBe(0)
    expect(torrent.eta).toBe(0)
    expect(torrent.content_path).toBe(record.destPath)
    expect(torrent.content_path).not.toBe(torrent.save_path)
  })

  test('hash is the stub infohash derived from release title + size', () => {
    const record = baseRecord()
    const torrent = toQbTorrent(record, { completedPath: '/tmp/completed', category: 'jack-abc12345' })
    expect(torrent.hash).toBe(deriveHash('Big Buck Bunny', 10))
  })

  test('failed maps to error state', () => {
    const record = baseRecord({ status: 'failed' })
    const torrent = toQbTorrent(record, { completedPath: '/tmp/completed', category: 'jack-abc12345' })
    expect(torrent.state).toBe('error')
  })
})
