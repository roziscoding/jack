import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { openMemoryDatabase } from '../database/connection'
import { PeerController } from '../modules/peer/peer.controller'
import { getPeerRouter } from '../modules/peer/peer.router'
import { UploadsRepository } from '../modules/uploads/uploads.repository'
import { UploadsService } from '../modules/uploads/uploads.service'

const input = {
  peerName: 'alice',
  itemId: 'radarr1:movie:1',
  filename: 'Movie.mkv',
  totalBytes: 12,
  rangeStart: 0,
  requestedBytes: 12,
}

describe('UploadsService', () => {
  test('a disconnect aborts the row; a finished response leaves it for the receipt', () => {
    const repository = new UploadsRepository(openMemoryDatabase())
    const service = new UploadsService(repository)
    const controller = new AbortController()
    const dropped = service.start(input, true, controller.signal)
    const finished = service.start(input, true, new AbortController().signal)

    controller.abort()

    expect(repository.get(dropped)).toMatchObject({ status: 'aborted', error: 'peer disconnected' })
    expect(repository.get(finished)?.status).toBe('uploading')
    expect(service.receipt(finished, 'alice', 12, 4000)).toBe(true)
    expect(repository.get(finished)).toMatchObject({ status: 'completed', sentBytes: 12, durationMs: 4000 })
  })

  test('a peer that sends no receipt starts unconfirmed', () => {
    const repository = new UploadsRepository(openMemoryDatabase())
    const id = new UploadsService(repository).start(input, false)
    expect(repository.get(id)?.status).toBe('unconfirmed')
  })
})

describe('peer file route and receipt', () => {
  let tempDir: string
  let filePath: string

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'jack-upload-'))
    filePath = join(tempDir, 'Movie.mkv')
    await Bun.write(filePath, new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]))
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  function setup() {
    const source = {
      id: 'remote1',
      name: 'My Radarr',
      type: 'radarr',
      canSource: true,
      getFilePath: async () => filePath,
    }
    const repository = new UploadsRepository(openMemoryDatabase())
    const app = new Hono()
    app.route('/peer', getPeerRouter(new PeerController(() => [source as any]), new UploadsService(repository)))
    return { app, repository }
  }

  test('serves a range request, then the receipt completes its row', async () => {
    const { app, repository } = setup()
    const res = await app.request('/peer/items/remote1:movie:1/file', {
      headers: { 'Range': 'bytes=6-', 'X-Jack-Receipt': '1' },
    })
    expect([
      ...new Uint8Array(await res.arrayBuffer()),
    ]).toEqual([6, 7, 8, 9])
    const uploadId = res.headers.get('X-Jack-Upload-Id')
    expect(repository.list()).toEqual([
      expect.objectContaining({
        peerName: 'master',
        totalBytes: 10,
        rangeStart: 6,
        requestedBytes: 4,
        status: 'uploading',
      }),
    ])

    const receipt = await app.request(`/peer/uploads/${uploadId}/receipt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bytes: 4, durationMs: 2 }),
    })
    expect(receipt.status).toBe(204)
    expect(repository.list()[0]).toMatchObject({ status: 'completed', sentBytes: 4, durationMs: 2 })
  })

  test('an unknown receipt id is ignored, a malformed body rejected', async () => {
    const { app } = setup()
    const unknown = await app.request('/peer/uploads/999/receipt', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bytes: 4, durationMs: 2 }),
    })
    expect(unknown.status).toBe(204)
    const malformed = await app.request('/peer/uploads/1/receipt', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bytes: -1 }),
    })
    expect(malformed.status).toBe(400)
  })

  test('does not record a HEAD request', async () => {
    const { app, repository } = setup()
    const res = await app.request('/peer/items/remote1:movie:1/file', { method: 'HEAD' })
    expect(res.headers.get('X-Jack-Upload-Id')).toBeNull()
    expect(repository.list()).toEqual([])
  })
})
