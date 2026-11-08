import { describe, expect, test } from 'bun:test'
import { openMemoryDatabase } from '../database/connection'
import { UploadsRepository } from '../modules/uploads/uploads.repository'

function makeRepo() {
  return new UploadsRepository(openMemoryDatabase())
}

const input = {
  peerName: 'alice',
  itemId: 'radarr1:movie:1',
  filename: 'Movie.mkv',
  totalBytes: 100,
  rangeStart: 40,
  requestedBytes: 60,
}

describe('UploadsRepository', () => {
  test('creates an uploading row with nothing sent', () => {
    const row = makeRepo().create(input)
    expect(row).toMatchObject({
      ...input,
      sentBytes: 0,
      status: 'uploading',
      error: null,
      finishedAt: null,
    })
  })

  test('records progress and the final outcome', () => {
    const repo = makeRepo()
    const { id } = repo.create(input)

    repo.updateProgress(id, 20)
    expect(repo.get(id)?.sentBytes).toBe(20)

    repo.finish(id, 'aborted', 30, 'peer disconnected')
    expect(repo.get(id)).toMatchObject({ status: 'aborted', sentBytes: 30, error: 'peer disconnected' })
    expect(repo.get(id)?.finishedAt).not.toBeNull()
  })

  test('lists newest first', () => {
    const repo = makeRepo()
    const first = repo.create(input)
    const second = repo.create(input)
    expect(repo.list().map(r => r.id)).toEqual([second.id, first.id])
  })

  test('marks rows left uploading by a previous run as aborted', () => {
    const repo = makeRepo()
    const running = repo.create(input)
    const done = repo.create(input)
    repo.finish(done.id, 'completed', 60)

    expect(repo.reconcileInterrupted()).toBe(1)
    expect(repo.get(running.id)).toMatchObject({ status: 'aborted', error: 'interrupted by a jack restart' })
    expect(repo.get(done.id)?.status).toBe('completed')
  })

  test('notifies subscribers on every change', () => {
    const repo = makeRepo()
    let calls = 0
    repo.subscribe(() => calls++)
    const { id } = repo.create(input)
    repo.updateProgress(id, 1)
    repo.finish(id, 'completed', 60)
    expect(calls).toBe(3)
  })
})
