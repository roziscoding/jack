import type { AuthVariables } from '../middleware/require-auth'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { openMemoryDatabase } from '../database/connection'
import { PeerController } from '../modules/peer/peer.controller'
import { getPeerRouter } from '../modules/peer/peer.router'
import { enrichDownload } from '../modules/status/status.controller'
import { UploadsRepository } from '../modules/uploads/uploads.repository'
import { UploadsService } from '../modules/uploads/uploads.service'

describe('peer transfers', () => {
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
    const app = new Hono<{ Variables: AuthVariables }>()
    // Stands in for require-auth: the `X-Key` header picks the api key row.
    app.use(async (c, next) => {
      const key = c.req.header('X-Key')
      if (key)
        c.set('apiKeyId', Number(key))
      await next()
    })
    app.route('/peer', getPeerRouter(new PeerController(() => [source as any]), new UploadsService(repository)))
    const create = (clientTransferId: string, key = '7') => app.request('/peer/items/remote1:movie:1/downloads', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Key': key },
      body: JSON.stringify({ clientTransferId }),
    })
    return { app, repository, create }
  }

  test('one transfer through a dropped request, a resume and the receipt', async () => {
    const { app, repository, create } = setup()
    const res = await create('download-1')
    expect(res.status).toBe(201)
    const transfer = await res.json() as { downloadId: string, url: string, totalBytes: number }
    expect(transfer).toMatchObject({ filename: 'Movie.mkv', totalBytes: 10, url: `/peer/downloads/${transfer.downloadId}/file` })

    // A lost 201: creating it again returns the same transfer.
    const again = await create('download-1')
    expect(again.status).toBe(200)
    expect((await again.json() as { downloadId: string }).downloadId).toBe(transfer.downloadId)

    // The first request drops after a few bytes; the transfer stays open.
    const first = await app.request(transfer.url, {
      headers: { 'X-Key': '7' },
    })
    await first.body?.cancel()
    const resumed = await app.request(transfer.url, {
      headers: { 'Range': 'bytes=6-', 'X-Key': '7' },
    })
    expect(resumed.status).toBe(206)
    expect([
      ...new Uint8Array(await resumed.arrayBuffer()),
    ]).toEqual([6, 7, 8, 9])
    expect(repository.list()).toEqual([
      expect.objectContaining({ status: 'uploading', rangeStart: 0, totalBytes: 10 }),
    ])

    const receipt = await app.request(`/peer/downloads/${transfer.downloadId}/receipt`, {
      method: 'POST',
      headers: { 'X-Key': '7' },
    })
    expect(receipt.status).toBe(204)
    expect(repository.list()).toEqual([
      expect.objectContaining({ status: 'completed', sentBytes: 10 }),
    ])
  })

  test('another key can neither stream nor complete a transfer', async () => {
    const { app, repository, create } = setup()
    const { downloadId, url } = await (await create('download-1')).json() as { downloadId: string, url: string }
    expect((await app.request(url, {
      headers: { 'X-Key': '8' },
    })).status).toBe(404)
    await app.request(url, {
      headers: { 'X-Key': '7' },
    })
    expect((await app.request(`/peer/downloads/${downloadId}/receipt`, {
      method: 'POST',
      headers: { 'X-Key': '8' },
    })).status).toBe(204)
    expect(repository.list()[0]?.status).toBe('uploading')
  })

  test('a client transfer id reused for another item is a conflict', async () => {
    const { app, create } = setup()
    await create('download-1')
    const res = await app.request('/peer/items/remote1:movie:2/downloads', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Key': '7' },
      body: JSON.stringify({ clientTransferId: 'download-1' }),
    })
    expect(res.status).toBe(409)
  })

  test('the item file route serves without recording, and a HEAD serves nothing', async () => {
    const { app, repository, create } = setup()
    const legacy = await app.request('/peer/items/remote1:movie:1/file', {
      headers: { Range: 'bytes=6-' },
    })
    expect([
      ...new Uint8Array(await legacy.arrayBuffer()),
    ]).toEqual([6, 7, 8, 9])
    expect(repository.list()).toEqual([])

    const { url } = await (await create('download-1')).json() as { url: string }
    await app.request(url, {
      method: 'HEAD',
      headers: { 'X-Key': '7' },
    })
    expect(repository.list()[0]?.rangeStart).toBeNull()
  })

  test('a malformed create is rejected', async () => {
    const { create } = setup()
    expect((await create('')).status).toBe(400)
  })
})

test('download speed and ETA come from the row, only while bytes still arrive', () => {
  const now = Date.parse('2026-11-08T12:00:00Z')
  const row = {
    status: 'downloading',
    expectedBytes: 10_000,
    releaseSize: 10_000,
    downloadedBytes: 2000,
    speedBps: 2000,
    updatedAt: '2026-11-08T11:59:50Z',
  } as Parameters<typeof enrichDownload>[0]
  expect(enrichDownload(row, now)).toMatchObject({ progress: 0.2, speedBps: 2000, etaSeconds: 4 })
  expect(enrichDownload({ ...row, status: 'import_queued' }, now)).toMatchObject({ speedBps: null, etaSeconds: null })
  // Nothing written for a minute: stalled, so no speed.
  expect(enrichDownload({ ...row, updatedAt: '2026-11-08T11:59:00Z' }, now)).toMatchObject({ speedBps: null, etaSeconds: null })
})
