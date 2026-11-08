import type { UploadOutcome } from '../modules/uploads/counting-stream'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { openMemoryDatabase } from '../database/connection'
import { PeerController } from '../modules/peer/peer.controller'
import { getPeerRouter } from '../modules/peer/peer.router'
import { countBytes } from '../modules/uploads/counting-stream'
import { UploadsRepository } from '../modules/uploads/uploads.repository'
import { UploadsService } from '../modules/uploads/uploads.service'

function recorder() {
  const progress: number[] = []
  const ends: { outcome: UploadOutcome, sentBytes: number, error: string | null }[] = []
  return {
    progress,
    ends,
    hooks: {
      onProgress: (sentBytes: number) => progress.push(sentBytes),
      onEnd: (outcome: UploadOutcome, sentBytes: number, error: string | null) => ends.push({ outcome, sentBytes, error }),
    },
  }
}

// A blob streamed in several chunks, so partial reads are possible.
function chunkedBlob() {
  return new Blob([
    new Uint8Array(3),
    new Uint8Array(4),
    new Uint8Array(5),
  ])
}

describe('countBytes', () => {
  test('passes the bytes through and ends as completed', async () => {
    const { progress, ends, hooks } = recorder()
    const body = await new Response(countBytes(new Blob([
      new Uint8Array([1, 2, 3, 4]),
    ]), hooks)).arrayBuffer()

    expect([
      ...new Uint8Array(body),
    ]).toEqual([1, 2, 3, 4])
    expect(progress.at(-1)).toBe(4)
    expect(ends).toEqual([
      { outcome: 'completed', sentBytes: 4, error: null },
    ])
  })

  test('ends as aborted when the consumer cancels', async () => {
    const { ends, hooks } = recorder()
    const reader = countBytes(chunkedBlob(), hooks).getReader()
    const first = await reader.read()
    await reader.cancel()

    expect(ends).toEqual([
      { outcome: 'aborted', sentBytes: first.value!.byteLength, error: 'peer disconnected' },
    ])
  })

  test('ends as aborted once when the request signal aborts', async () => {
    const { ends, hooks } = recorder()
    const controller = new AbortController()
    const stream = countBytes(chunkedBlob(), hooks, controller.signal)
    controller.abort()
    await stream.cancel().catch(() => {})

    expect(ends).toEqual([
      { outcome: 'aborted', sentBytes: 0, error: 'peer disconnected' },
    ])
  })

  test('ends as failed when the file cannot be read', async () => {
    const { ends, hooks } = recorder()
    const missing = Bun.file(join(tmpdir(), 'jack-missing-upload-file'))
    await expect(new Response(countBytes(missing, hooks)).arrayBuffer()).rejects.toThrow()

    expect(ends).toHaveLength(1)
    expect(ends[0]!.outcome).toBe('failed')
  })
})

describe('UploadsService.track', () => {
  test('writes the row on finish and feeds the live tracker while running', async () => {
    const repository = new UploadsRepository(openMemoryDatabase())
    const service = new UploadsService(repository)
    const stream = service.track({
      peerName: 'alice',
      itemId: 'radarr1:movie:1',
      filename: 'Movie.mkv',
      totalBytes: 12,
      rangeStart: 0,
      requestedBytes: 12,
    }, chunkedBlob())

    const [running] = repository.list()
    expect(running?.status).toBe('uploading')
    expect(service.live.get(running!.id)?.downloadedBytes).toBe(0)

    await new Response(stream).arrayBuffer()

    expect(repository.get(running!.id)).toMatchObject({ status: 'completed', sentBytes: 12 })
    expect(service.live.get(running!.id)).toBeNull()
  })
})

describe('GET /peer/items/:id/file upload tracking', () => {
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

  test('records a range request with its start and the bytes sent', async () => {
    const { app, repository } = setup()
    const res = await app.request('/peer/items/remote1:movie:1/file', {
      headers: { Range: 'bytes=6-' },
    })
    expect([
      ...new Uint8Array(await res.arrayBuffer()),
    ]).toEqual([6, 7, 8, 9])

    expect(repository.list()).toEqual([
      expect.objectContaining({
        peerName: 'master',
        itemId: 'remote1:movie:1',
        filename: 'Movie.mkv',
        totalBytes: 10,
        rangeStart: 6,
        requestedBytes: 4,
        sentBytes: 4,
        status: 'completed',
      }),
    ])
  })

  test('does not record a HEAD request', async () => {
    const { app, repository } = setup()
    await app.request('/peer/items/remote1:movie:1/file', { method: 'HEAD' })
    expect(repository.list()).toEqual([])
  })
})
