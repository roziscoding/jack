import { expect, test } from 'bun:test'
import { LiveProgressTracker } from '../modules/downloads/live-progress'
import { enrichDownload } from '../modules/status/status.controller'

test('speed is averaged over the window and resets when bytes go backwards', () => {
  const clock = { now: 0 }
  const live = new LiveProgressTracker(() => clock.now)

  live.record(1, 0)
  expect(live.get(1)).toEqual({ downloadedBytes: 0, speedBps: null })

  clock.now = 2000
  live.record(1, 4000)
  expect(live.get(1)).toEqual({ downloadedBytes: 4000, speedBps: 2000 })

  // A restart drops the window instead of reporting a negative speed.
  clock.now = 3000
  live.record(1, 100)
  expect(live.get(1)).toEqual({ downloadedBytes: 100, speedBps: null })

  // A stall keeps the byte count but drops the speed.
  clock.now = 3500
  live.record(1, 1100)
  expect(live.get(1)?.speedBps).toBe(2000)
  clock.now = 9000
  expect(live.get(1)).toEqual({ downloadedBytes: 1100, speedBps: null })

  live.clear(1)
  expect(live.get(1)).toBeNull()
})

test('enrichDownload overlays live bytes, speed and ETA on a running transfer', () => {
  const clock = { now: 0 }
  const live = new LiveProgressTracker(() => clock.now)
  live.record(7, 1000)
  clock.now = 1000
  live.record(7, 3000)

  const row = {
    id: 7,
    status: 'downloading',
    downloadedBytes: 500,
    expectedBytes: 10_000,
    releaseSize: 10_000,
  } as Parameters<typeof enrichDownload>[0]
  expect(enrichDownload(row, live)).toMatchObject({
    downloadedBytes: 3000,
    progress: 0.3,
    speedBps: 2000,
    etaSeconds: 4,
  })

  // Finished rows ignore whatever the tracker still holds.
  expect(enrichDownload({ ...row, status: 'import_queued' }, live)).toMatchObject({ downloadedBytes: 500, speedBps: null, etaSeconds: null })
})
