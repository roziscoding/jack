import type { DownloadRecord } from '../modules/downloads/downloads.repository'
import { expect, test } from 'bun:test'
import { FailedDownloadReaper } from '../modules/downloads/failed-download-reaper'

function failedRow(overrides: Partial<DownloadRecord> = {}): DownloadRecord {
  return {
    id: 1,
    filename: 'Movie.mkv',
    status: 'failed',
    errorCode: 'PEER_UNREACHABLE',
    operationFailed: true,
    lastOperation: 'transfer',
    importMode: null,
    importTarget: null,
    ...overrides,
  } as DownloadRecord
}

function setup(rows: DownloadRecord[], options: { enabled?: boolean, retryFails?: boolean } = {}) {
  const clock = { now: 0 }
  const calls: string[] = []
  const reaper = new FailedDownloadReaper({
    enabled: () => options.enabled ?? true,
    list: () => [...rows],
    get: id => rows.find(row => row.id === id) ?? null,
    retry: async (id) => {
      calls.push(`retry:${id}`)
      if (options.retryFails)
        throw new Error('nope')
    },
    remove: async (id, onlyIf) => {
      const index = rows.findIndex(row => row.id === id)
      if (!onlyIf(rows[index]!))
        return
      calls.push(`remove:${id}`)
      rows.splice(index, 1)
    },
    maxRetries: 3,
    baseDelayMs: 100,
    maxDelayMs: 250,
    now: () => clock.now,
  })
  return { reaper, clock, calls }
}

test('re-reads each row, so one the user cancelled mid-pass is left alone', async () => {
  const second = failedRow({ id: 2, lastOperation: 'import' })
  const rows = [
    failedRow({ id: 1, lastOperation: 'import' }),
    second,
  ]
  const { reaper, calls } = setup(rows)
  // The pass lists both rows, then the user cancels row 2 before the reaper gets to it.
  const original = rows[0]!
  Object.defineProperty(original, 'status', {
    get() {
      second.errorCode = 'CANCELLED'
      return 'failed'
    },
  })
  await reaper.tick()
  expect(calls).toEqual(['remove:1'])
})

test('retries with backoff, then removes the download once retries are spent', async () => {
  const rows = [
    failedRow(),
  ]
  const { reaper, clock, calls } = setup(rows)

  // Delays: 100, 200, then 400 capped to 250. Every retry fails again (row stays failed).
  for (const at of [
    0,
    99,
    100,
    100,
    299,
    300,
    300,
    549,
    550,
    550,
  ])
    await (clock.now = at, reaper.tick())

  expect(calls).toEqual([
    'retry:1',
    'retry:1',
    'retry:1',
    'remove:1',
  ])
  expect(rows).toHaveLength(0)
})

test('a retry that throws still counts toward the limit', async () => {
  const rows = [
    failedRow(),
  ]
  const { reaper, clock, calls } = setup(rows, { retryFails: true })
  for (let at = 0; at <= 2000; at += 50)
    await (clock.now = at, reaper.tick())
  expect(calls).toEqual([
    'retry:1',
    'retry:1',
    'retry:1',
    'remove:1',
  ])
})

test('removes a failure that cannot be retried right away', async () => {
  const rows = [
    failedRow({ lastOperation: 'import', importMode: null }),
  ]
  const { reaper, calls } = setup(rows)
  await reaper.tick()
  expect(calls).toEqual(['remove:1'])
})

test('leaves user cancels and other statuses alone', async () => {
  const rows = [
    failedRow({ id: 1, errorCode: 'CANCELLED' }),
    failedRow({ id: 2, status: 'downloading' }),
    failedRow({ id: 3, status: 'imported' }),
  ]
  const { reaper, clock, calls } = setup(rows)
  for (const at of [0, 1000, 5000])
    await (clock.now = at, reaper.tick())
  expect(calls).toEqual([])
})

test('does nothing while disabled', async () => {
  const rows = [
    failedRow({ lastOperation: 'import' }),
  ]
  const { reaper, calls } = setup(rows, { enabled: false })
  await reaper.tick()
  expect(calls).toEqual([])
})
