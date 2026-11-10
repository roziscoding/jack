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
  clientTransferId: 'download-1',
}
// The file as served, unchanged since the transfer started.
const file = { filename: 'Movie.mkv', totalBytes: 100 }

describe('UploadsRepository', () => {
  test('creates an open transfer with nothing served yet', () => {
    const { upload, created } = makeRepo().create(input)
    expect(created).toBe(true)
    expect(upload).toMatchObject({
      peerName: 'alice',
      peerKeyId: 7,
      totalBytes: 100,
      rangeStart: null,
      sentBytes: 0,
      durationMs: null,
      status: 'uploading',
      finishedAt: null,
    })
    expect(upload.transferId).toMatch(/^[0-9a-f-]{36}$/)
  })

  test('creating the same transfer again returns it; ids are scoped per key', () => {
    const repo = makeRepo()
    const first = repo.create(input).upload
    expect(repo.create(input)).toEqual({ upload: first, created: false })
    expect(repo.create({ ...input, peerKeyId: 8 }).created).toBe(true)
    expect(repo.create({ ...input, peerKeyId: null }).created).toBe(true)
    expect(repo.create({ ...input, peerKeyId: null }).created).toBe(false)
    expect(repo.list()).toHaveLength(3)
  })

  test('only the owning key finds a transfer', () => {
    const repo = makeRepo()
    const { transferId } = repo.create(input).upload
    expect(repo.findOwned(transferId, 7)?.transferId).toBe(transferId)
    expect(repo.findOwned(transferId, 8)).toBeNull()
    expect(repo.findOwned(transferId, null)).toBeNull()
  })

  test('the receipt completes it with the bytes served since the lowest range, from creation', () => {
    const repo = makeRepo()
    const { id, transferId, startedAt } = repo.create(input).upload
    const now = Date.parse(startedAt) + 5000

    // Never requested: nothing was sent, so there is nothing to complete.
    expect(repo.complete(transferId, 7, now)).toBe(false)
    repo.served(id, 60, file)
    repo.served(id, 40, file)
    repo.served(id, 70, file)
    // Another key, even one with the same name, can't close it; nor can the master key.
    expect(repo.complete(transferId, 8, now)).toBe(false)
    expect(repo.complete(transferId, null, now)).toBe(false)
    expect(repo.complete(transferId, 7, now)).toBe(true)
    expect(repo.get(id)).toMatchObject({
      status: 'completed',
      rangeStart: 40,
      sentBytes: 60,
      durationMs: 5000,
    })
    // Closed rows stay closed, and serving them again changes nothing.
    expect(repo.complete(transferId, 7, now)).toBe(false)
    repo.served(id, 0, file)
    expect(repo.get(id)?.rangeStart).toBe(40)
  })

  test('a file replaced mid-transfer counts from the request that served the new one', () => {
    const repo = makeRepo()
    const { id, transferId } = repo.create(input).upload
    repo.served(id, 40, file)
    // *arr swapped in a 250-byte file; the peer's resume fails and it starts over.
    repo.served(id, 0, { filename: 'Movie.2160p.mkv', totalBytes: 250 })
    repo.served(id, 100, { filename: 'Movie.2160p.mkv', totalBytes: 250 })
    expect(repo.complete(transferId, 7)).toBe(true)
    expect(repo.get(id)).toMatchObject({
      filename: 'Movie.2160p.mkv',
      totalBytes: 250,
      rangeStart: 0,
      sentBytes: 250,
    })
  })

  test('expires transfers that waited too long; a late receipt still completes one', () => {
    const repo = makeRepo()
    const { id, transferId } = repo.create(input).upload
    repo.served(id, 0, file)
    expect(repo.expireUnconfirmed('2000-01-01T00:00:00Z')).toBe(0)
    expect(repo.expireUnconfirmed('9999-01-01T00:00:00Z')).toBe(1)
    expect(repo.get(id)?.status).toBe('unconfirmed')
    expect(repo.complete(transferId, 7)).toBe(true)
    expect(repo.get(id)).toMatchObject({ status: 'completed', sentBytes: 100 })
  })

  test('summarizes in SQL and lists only open transfers as active', () => {
    const repo = makeRepo()
    repo.create({ ...input, clientTransferId: 'a' })
    const done = repo.create({ ...input, clientTransferId: 'b' }).upload
    repo.served(done.id, 40, file)
    repo.complete(done.transferId, 7)
    repo.create({ ...input, clientTransferId: 'c' })
    // Expires a and c; d is the only one still open.
    repo.expireUnconfirmed('9999-01-01T00:00:00Z')
    const open = repo.create({ ...input, clientTransferId: 'd' }).upload

    expect(repo.summary()).toEqual({
      byStatus: {
        uploading: 1,
        completed: 1,
        unconfirmed: 2,
      },
      total: 4,
      bytesSent: 60,
    })
    expect(repo.listActive().map(r => r.id)).toEqual([open.id])
  })

  test('lists newest first', () => {
    const repo = makeRepo()
    const first = repo.create({ ...input, clientTransferId: 'a' }).upload
    const second = repo.create({ ...input, clientTransferId: 'b' }).upload
    expect(repo.list().map(r => r.id)).toEqual([second.id, first.id])
  })

  test('notifies subscribers on every change', () => {
    const repo = makeRepo()
    let calls = 0
    repo.subscribe(() => calls++)
    const { id, transferId } = repo.create(input).upload
    repo.create(input)
    repo.served(id, 0, file)
    repo.complete(transferId, 7)
    expect(calls).toBe(3)
  })
})
