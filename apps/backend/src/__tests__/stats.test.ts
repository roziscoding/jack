import type { NewDownloadRow, NewUploadRow } from '../database/schema'
import { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { runMigrations } from '../database/connection'
import * as schema from '../database/schema'
import { catalogSizeHistory, downloads, ownCatalogTitles, peerCatalogTitles, uploads } from '../database/schema'
import { StatsRepository } from '../modules/stats/stats.repository'

const NOW = Date.parse('2026-11-08T12:00:00Z')

function setup() {
  const database = new Database(':memory:')
  const db = drizzle({ client: database, schema })
  runMigrations(db)
  return {
    database,
    db,
    repo: new StatsRepository(db),
  }
}

function download(overrides: Partial<NewDownloadRow>): NewDownloadRow {
  return {
    torrentFilename: 'x.torrent',
    peerId: 'peer-r',
    peerName: 'Ranieri',
    itemId: '1',
    filename: 'Movie.mkv',
    destPath: '/d/Movie.mkv',
    partPath: '/d/Movie.mkv.part',
    releaseSize: 1,
    releaseJson: '{}',
    status: 'imported',
    downloadedBytes: 0,
    startedAt: '2026-11-08T10:00:00Z',
    updatedAt: '2026-11-08T10:00:00Z',
    ...overrides,
  }
}

function upload(overrides: Partial<NewUploadRow>): NewUploadRow {
  return {
    peerName: 'Roz',
    peerKeyId: 7,
    itemId: '1',
    filename: 'Movie.mkv',
    totalBytes: 1000,
    requestedBytes: 400,
    status: 'completed',
    startedAt: '2026-11-07T09:00:00Z',
    updatedAt: '2026-11-07T09:00:00Z',
    ...overrides,
  }
}

test('aggregates daily series and rankings in SQL', () => {
  const { database, db, repo } = setup()
  db.insert(downloads).values([
    download({
      downloadedBytes: 1000,
      startedAt: '2026-11-08T10:00:00Z',
      completedAt: '2026-11-08T10:00:10Z',
      importedAt: '2026-11-08T10:01:10Z',
    }),
    download({
      peerId: 'peer-z',
      peerName: 'Roz',
      status: 'failed',
      errorCode: 'PEER_UNREACHABLE',
      downloadedBytes: 500,
    }),
    // Outside the window: counts toward lifetime peers, not the daily series.
    download({ downloadedBytes: 7, completedAt: '2026-10-01T00:00:00Z' }),
    // Same peer id renamed later: one entry, under its latest name.
    download({ peerName: 'Ranieri (new)', downloadedBytes: 3, updatedAt: '2026-11-08T11:00:00Z' }),
  ]).run()
  db.insert(uploads).values([
    // Confirmed by a receipt: 400 bytes in 4 s.
    upload({ sentBytes: 400, durationMs: 4000, finishedAt: '2026-11-07T09:00:04Z' }),
    // No receipt, so nothing is known to have arrived.
    upload({ status: 'aborted', finishedAt: '2026-11-07T09:30:00Z' }),
    // Another key with the same name stays a separate peer.
    upload({
      peerKeyId: 8,
      filename: 'Show.mkv',
      sentBytes: 50,
      durationMs: 1000,
      finishedAt: '2026-11-07T10:00:00Z',
    }),
  ]).run()

  const stats = repo.dashboard(3, NOW)

  expect(stats.days).toEqual(['2026-11-06', '2026-11-07', '2026-11-08'])
  expect(stats.transfers[2]).toEqual({
    day: '2026-11-08',
    downloadedBytes: 1000,
    uploadedBytes: 0,
    downloadBps: 100,
    uploadBps: null,
  })
  expect(stats.transfers[1]).toMatchObject({ uploadedBytes: 450, uploadBps: 90 })
  expect(stats.importLatency[2]).toEqual({ day: '2026-11-08', avgSeconds: 60, count: 1 })
  expect(stats.peers.gaveToMe).toEqual([
    { id: 'peer-r', name: 'Ranieri (new)', bytes: 1010 },
    { id: 'peer-z', name: 'Roz', bytes: 500 },
  ])
  expect(stats.peers.tookFromMe).toEqual([
    { id: '7', name: 'Roz', bytes: 400 },
    { id: '8', name: 'Roz', bytes: 50 },
  ])
  expect(stats.failures).toEqual([
    { code: 'PEER_UNREACHABLE', count: 1 },
  ])
  expect(stats.topTitles[0]).toEqual({
    filename: 'Movie.mkv',
    bytes: 400,
    requests: 2,
    peers: 1,
  })
  database.close()
})

test('records one catalog size row per source per day, zero for an empty catalog', () => {
  const { database, db, repo } = setup()
  const title = {
    mediaType: 'movie' as const,
    title: 'A',
    releaseCount: 1,
    resolutions: [1080],
    updatedAt: 'x',
  }
  db.insert(ownCatalogTitles).values([
    {
      ...title,
      titleKey: 'a',
      totalSize: 10,
      revision: 1,
    },
    {
      ...title,
      titleKey: 'b',
      totalSize: 99,
      revision: 2,
      deleted: true,
    },
  ]).run()
  db.insert(peerCatalogTitles).values([
    {
      ...title,
      peerId: 'p1',
      titleKey: 'a',
      totalSize: 5,
    },
    {
      ...title,
      peerId: 'p1',
      titleKey: 'b',
      totalSize: 6,
    },
    {
      ...title,
      peerId: 'gone',
      titleKey: 'a',
      totalSize: 1,
    },
  ]).run()

  repo.recordCatalogSizes(new Map([
    ['p1', 'Friend'],
  ]), '2026-11-08')
  // Same day again: p1 renamed, and p2 is configured with nothing cached.
  repo.recordCatalogSizes(new Map([
    ['p1', 'Friend renamed'],
    ['p2', 'Empty'],
  ]), '2026-11-08')

  expect(db.select().from(catalogSizeHistory).all()).toEqual([
    {
      day: '2026-11-08',
      sourceId: 'self',
      sourceName: 'This instance',
      titles: 1,
      bytes: 10,
    },
    {
      day: '2026-11-08',
      sourceId: 'p1',
      sourceName: 'Friend renamed',
      titles: 2,
      bytes: 11,
    },
    {
      day: '2026-11-08',
      sourceId: 'p2',
      sourceName: 'Empty',
      titles: 0,
      bytes: 0,
    },
  ])
  expect(repo.catalogSizesSince('2026-11-09')).toEqual([])
  database.close()
})
