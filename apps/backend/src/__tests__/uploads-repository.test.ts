import { describe, expect, test } from 'bun:test'
import { openMemoryDatabase } from '../database/connection'
import { UploadsRepository } from '../modules/uploads/uploads.repository'

function makeRepo() {
  return new UploadsRepository(openMemoryDatabase())
}

const input = {
  peerName: 'alice',
  peerKeyId: 7,
  itemId: 'radarr1:movie:1',
  filename: 'Movie.mkv',
  totalBytes: 100,
  rangeStart: 40,
  requestedBytes: 60,
}

describe('UploadsRepository', () => {
  test('creates a row with nothing sent yet', () => {
    const row = makeRepo().create(input, 'uploading')
    expect(row).toMatchObject({
      ...input,
      sentBytes: 0,
      durationMs: null,
      status: 'uploading',
      error: null,
      finishedAt: null,
    })
  })

  test('a receipt from the same peer completes it with bytes and duration', () => {
    const repo = makeRepo()
    const { id } = repo.create(input, 'uploading')

    // Another key, even one with the same name, can't close it; nor can the master key.
    expect(repo.complete(id, 8, 60, 1000)).toBe(false)
    expect(repo.complete(id, null, 60, 1000)).toBe(false)
    // More bytes than the request asked for (60) is rejected.
    expect(repo.complete(id, 7, 61, 1000)).toBe(false)
    expect(repo.complete(id, 7, 60, 2000)).toBe(true)
    expect(repo.get(id)).toMatchObject({ status: 'completed', sentBytes: 60, durationMs: 2000 })
    expect(repo.get(id)?.finishedAt).not.toBeNull()
    // Closed rows stay closed.
    expect(repo.complete(id, 7, 1, 1)).toBe(false)
  })

  test('an older peer\'s row can still be completed or aborted', () => {
    const repo = makeRepo()
    const a = repo.create(input, 'unconfirmed')
    const b = repo.create(input, 'unconfirmed')
    repo.markAborted(a.id, 'peer disconnected')
    expect(repo.complete(b.id, 7, 60, 10)).toBe(true)
    expect(repo.get(a.id)?.status).toBe('aborted')
  })

  test('a disconnect after completion changes nothing', () => {
    const repo = makeRepo()
    const { id } = repo.create(input, 'uploading')
    repo.complete(id, 7, 60, 10)
    repo.markAborted(id, 'peer disconnected')
    expect(repo.get(id)?.status).toBe('completed')
  })

  test('expires rows that waited too long for a receipt', () => {
    const repo = makeRepo()
    const { id } = repo.create(input, 'uploading')
    expect(repo.expireUnconfirmed('2000-01-01T00:00:00Z')).toBe(0)
    expect(repo.expireUnconfirmed('9999-01-01T00:00:00Z')).toBe(1)
    expect(repo.get(id)?.status).toBe('unconfirmed')
  })

  test('summarizes in SQL and lists only running uploads as active', () => {
    const repo = makeRepo()
    const running = repo.create(input, 'uploading')
    const done = repo.create(input, 'uploading')
    repo.complete(done.id, 7, 60, 10)
    repo.create(input, 'unconfirmed')

    expect(repo.summary()).toEqual({
      byStatus: {
        uploading: 1,
        completed: 1,
        aborted: 0,
        unconfirmed: 1,
      },
      total: 3,
      bytesSent: 60,
    })
    expect(repo.listActive().map(r => r.id)).toEqual([running.id])
  })

  test('lists newest first', () => {
    const repo = makeRepo()
    const first = repo.create(input, 'uploading')
    const second = repo.create(input, 'uploading')
    expect(repo.list().map(r => r.id)).toEqual([second.id, first.id])
  })

  test('marks rows left uploading by a previous run as aborted', () => {
    const repo = makeRepo()
    const running = repo.create(input, 'uploading')
    const done = repo.create(input, 'uploading')
    repo.complete(done.id, 7, 60, 10)

    expect(repo.reconcileInterrupted()).toBe(1)
    expect(repo.get(running.id)).toMatchObject({ status: 'aborted', error: 'interrupted by a jack restart' })
    expect(repo.get(done.id)?.status).toBe('completed')
  })

  test('notifies subscribers on every change', () => {
    const repo = makeRepo()
    let calls = 0
    repo.subscribe(() => calls++)
    const { id } = repo.create(input, 'uploading')
    repo.complete(id, 7, 60, 10)
    expect(calls).toBe(2)
  })
})
