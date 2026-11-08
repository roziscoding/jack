import type { DownloadRecord } from '../modules/downloads/downloads.repository'
import type { UploadRecord } from '../modules/uploads/uploads.repository'
import { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { runMigrations } from '../database/connection'
import * as schema from '../database/schema'
import { catalogSizeHistory, ownCatalogTitles, peerCatalogTitles } from '../database/schema'
import { buildStats } from '../modules/stats/stats'
import { StatsRepository } from '../modules/stats/stats.repository'

const NOW = Date.parse('2026-11-08T12:00:00Z')

function download(overrides: Partial<DownloadRecord>): DownloadRecord {
  return {
    peerName: 'Ranieri',
    status: 'imported',
    downloadedBytes: 0,
    errorCode: null,
    startedAt: '2026-11-08T10:00:00Z',
    completedAt: null,
    importedAt: null,
    ...overrides,
  } as DownloadRecord
}

function upload(overrides: Partial<UploadRecord>): UploadRecord {
  return {
    peerName: 'Roz',
    filename: 'Movie.mkv',
    status: 'completed',
    sentBytes: 0,
    startedAt: '2026-11-08T10:00:00Z',
    finishedAt: null,
    ...overrides,
  } as UploadRecord
}

test('buckets transfers, speed and import latency per day', () => {
  const stats = buildStats([
    download({
      downloadedBytes: 1000,
      startedAt: '2026-11-08T10:00:00Z',
      completedAt: '2026-11-08T10:00:10Z',
      importedAt: '2026-11-08T10:01:10Z',
    }),
    download({
      peerName: 'Roz',
      status: 'failed',
      errorCode: 'PEER_UNREACHABLE',
      downloadedBytes: 500,
    }),
    // Outside the window: counts toward lifetime peers, not the daily series.
    download({ downloadedBytes: 7, completedAt: '2026-10-01T00:00:00Z' }),
  ], [
    upload({ sentBytes: 400, startedAt: '2026-11-07T09:00:00Z', finishedAt: '2026-11-07T09:00:04Z' }),
    upload({ sentBytes: 100, status: 'aborted', finishedAt: '2026-11-07T09:30:00Z' }),
    upload({
      filename: 'Show.mkv',
      peerName: 'Ranieri',
      sentBytes: 50,
      finishedAt: null,
    }),
  ], [], 3, NOW)

  expect(stats.days).toEqual(['2026-11-06', '2026-11-07', '2026-11-08'])
  expect(stats.transfers[2]).toEqual({
    day: '2026-11-08',
    downloadedBytes: 1000,
    uploadedBytes: 0,
    downloadBps: 100,
    uploadBps: null,
  })
  // Aborted bytes count as moved but don't drag the speed down.
  expect(stats.transfers[1]).toMatchObject({ uploadedBytes: 500, uploadBps: 100 })
  expect(stats.importLatency[2]).toEqual({ day: '2026-11-08', avgSeconds: 60, count: 1 })
  expect(stats.peers.gaveToMe).toEqual([
    { name: 'Ranieri', bytes: 1007 },
    { name: 'Roz', bytes: 500 },
  ])
  expect(stats.peers.tookFromMe).toEqual([
    { name: 'Roz', bytes: 500 },
    { name: 'Ranieri', bytes: 50 },
  ])
  expect(stats.failures).toEqual([
    { code: 'PEER_UNREACHABLE', count: 1 },
  ])
  expect(stats.topTitles[0]).toEqual({
    filename: 'Movie.mkv',
    bytes: 500,
    requests: 2,
    peers: 1,
  })
})

test('records one catalog size row per source per day', () => {
  const database = new Database(':memory:')
  const db = drizzle({ client: database, schema })
  runMigrations(db)
  const repo = new StatsRepository(db)
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
  repo.recordCatalogSizes(new Map([
    ['p1', 'Friend renamed'],
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
  ])
  expect(repo.catalogSizesSince('2026-11-09')).toEqual([])
  database.close()
})
