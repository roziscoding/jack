import type { PeerDownloadProgressEvent } from '../lib/servers/peer'
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from 'bun:test'
import { http, HttpResponse } from 'msw'
import { setupServer } from 'msw/node'
import { IdleTimeoutError } from '../lib/errors/IdleTimeoutError'
import { UnknownSizeError } from '../lib/errors/UnknownSizeError'
import { PeerConnector } from '../lib/servers/peer'

const PEER_JACK_URL = 'http://download-peer.test:3000'

const server = setupServer(
  http.get(`${PEER_JACK_URL}/peer/search`, () => HttpResponse.json({ items: [] })),
)

beforeAll(() => server.listen({ onUnhandledRequest: 'bypass' }))
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

function markInitialized<T extends object>(connector: T): T {
  ;(connector as any)._isInitialized = true
  return connector
}

// In this MSW/Bun version a `new Response(Uint8Array)` body reads back as 0
// bytes through getReader(); a ReadableStream body streams correctly (and keeps
// an explicit Content-Length header), matching the connector's streaming path.
function streamOf(bytes: number[]) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(bytes))
      controller.close()
    },
  })
}

async function waitFor(predicate: () => Promise<boolean>) {
  for (let i = 0; i < 50; i++) {
    if (await predicate())
      return
    await Bun.sleep(20)
  }
  throw new Error('Timed out waiting for condition')
}

async function openFileDescriptorCount() {
  if (process.platform !== 'linux')
    return null
  return (await readdir('/proc/self/fd')).length
}

describe('PeerConnector.downloadFile', () => {
  test('streams to a .part file before renaming to the completed file', async () => {
    const firstChunk = new Uint8Array([1, 2, 3])
    const secondChunk = new Uint8Array([4, 5])
    const releaseSecondChunk = Promise.withResolvers<void>()
    const seenHeaders: Record<string, string | null> = {}

    server.use(
      http.get(`${PEER_JACK_URL}/peer/items/:itemId/file`, ({ request }) => {
        seenHeaders.custom = request.headers.get('X-Custom-Auth')
        seenHeaders.apiKey = request.headers.get('X-Api-Key')
        return new Response(new ReadableStream({
          async start(controller) {
            controller.enqueue(firstChunk)
            await releaseSecondChunk.promise
            controller.enqueue(secondChunk)
            controller.close()
          },
        }), {
          headers: { 'Content-Length': String(firstChunk.byteLength + secondChunk.byteLength) },
        })
      }),
    )

    const peer = markInitialized(new PeerConnector({
      url: PEER_JACK_URL,
      apiKey: 'peer-api-key',
      name: 'Friend Jack',
      headers: {
        'X-Custom-Auth': 'custom-secret',
        'X-Api-Key': 'should-not-override',
      },
    }))
    const dir = await mkdtemp(join(tmpdir(), 'jack-peer-download-'))
    const destPath = join(dir, 'Movie.mkv')
    const partPath = `${destPath}.part`

    try {
      const download = peer.downloadFile('remote1:movie:99', destPath)

      await waitFor(async () => await Bun.file(partPath).exists())
      expect(await Bun.file(destPath).exists()).toBe(false)

      releaseSecondChunk.resolve()
      await download

      expect(await Bun.file(partPath).exists()).toBe(false)
      expect(new Uint8Array(await Bun.file(destPath).arrayBuffer())).toEqual(new Uint8Array([1, 2, 3, 4, 5]))
      expect(seenHeaders.custom).toBe('custom-secret')
      expect(seenHeaders.apiKey).toBe('peer-api-key')
    }
    finally {
      releaseSecondChunk.resolve()
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('reports expected bytes from Content-Length and streamed progress', async () => {
    server.use(
      http.get(`${PEER_JACK_URL}/peer/items/:itemId/file`, () => {
        return new Response(streamOf([1, 2, 3, 4]), { headers: { 'Content-Length': '4' } })
      }),
    )

    const peer = markInitialized(new PeerConnector({ url: PEER_JACK_URL, apiKey: 'peer-api-key', name: 'Friend Jack' }))
    const dir = await mkdtemp(join(tmpdir(), 'jack-peer-progress-'))
    const events: unknown[] = []

    try {
      await peer.downloadFile('remote1:movie:99', join(dir, 'Movie.mkv'), {
        torrentFilename: 'movie.torrent',
        releaseSize: 4,
        onProgress: (event) => { events.push(event) },
      })

      expect(events).toContainEqual({ type: 'headers', expectedBytes: 4, expectedBytesSource: 'content_length', expectedBytesMismatch: false })
      // The first chunk always emits a progress event (lastLoggedBytes === 0).
      expect(events).toContainEqual({ type: 'progress', downloadedBytes: 4, expectedBytes: 4 })
      expect(events).toContainEqual({ type: 'completed', downloadedBytes: 4, expectedBytes: 4 })
    }
    finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('falls back to releaseSize for expected bytes when Content-Length is missing or invalid', async () => {
    for (const contentLength of [null, 'not-a-number']) {
      server.resetHandlers()
      server.use(
        http.get(`${PEER_JACK_URL}/peer/items/:itemId/file`, () => {
          const headers = contentLength == null ? {} : { 'Content-Length': contentLength }
          return new Response(streamOf([1, 2]), { headers })
        }),
      )

      const peer = markInitialized(new PeerConnector({ url: PEER_JACK_URL, apiKey: 'peer-api-key', name: 'Friend Jack' }))
      const dir = await mkdtemp(join(tmpdir(), 'jack-peer-fallback-'))
      const events: unknown[] = []

      try {
        await peer.downloadFile('remote1:movie:99', join(dir, 'Movie.mkv'), {
          releaseSize: 2,
          onProgress: (event) => { events.push(event) },
        })

        expect(events).toContainEqual({ type: 'headers', expectedBytes: 2, expectedBytesSource: 'release_size', expectedBytesMismatch: false })
        expect(events).toContainEqual({ type: 'completed', downloadedBytes: 2, expectedBytes: 2 })
      }
      finally {
        await rm(dir, { recursive: true, force: true })
      }
    }
  })

  test('fails fast with UnknownSizeError when neither Content-Length nor releaseSize is known', async () => {
    server.use(
      http.get(`${PEER_JACK_URL}/peer/items/:itemId/file`, () => {
        return new Response(streamOf([1, 2]), { headers: {} })
      }),
    )

    const peer = markInitialized(new PeerConnector({ url: PEER_JACK_URL, apiKey: 'peer-api-key', name: 'Friend Jack' }))
    const dir = await mkdtemp(join(tmpdir(), 'jack-peer-nosize-'))
    const destPath = join(dir, 'Movie.mkv')
    const partPath = `${destPath}.part`

    try {
      await expect(peer.downloadFile('remote1:movie:99', destPath, { partPath })).rejects.toThrow(UnknownSizeError)
      // Fail-fast: nothing is written before the size is known.
      expect(await Bun.file(destPath).exists()).toBe(false)
      expect(await Bun.file(partPath).exists()).toBe(false)
    }
    finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('reports Content-Length mismatches against releaseSize', async () => {
    server.use(
      http.get(`${PEER_JACK_URL}/peer/items/:itemId/file`, () => {
        return new Response(streamOf([1, 2, 3]), { headers: { 'Content-Length': '3' } })
      }),
    )

    const peer = markInitialized(new PeerConnector({ url: PEER_JACK_URL, apiKey: 'peer-api-key', name: 'Friend Jack' }))
    const dir = await mkdtemp(join(tmpdir(), 'jack-peer-mismatch-'))
    const events: unknown[] = []

    try {
      await peer.downloadFile('remote1:movie:99', join(dir, 'Movie.mkv'), {
        releaseSize: 4,
        onProgress: (event) => { events.push(event) },
      })

      expect(events).toContainEqual({ type: 'headers', expectedBytes: 3, expectedBytesSource: 'content_length', expectedBytesMismatch: true })
    }
    finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('does not fail a completed file download when the completed progress callback throws', async () => {
    server.use(
      http.get(`${PEER_JACK_URL}/peer/items/:itemId/file`, () => {
        return new Response(streamOf([1, 2, 3, 4]), { headers: { 'Content-Length': '4' } })
      }),
    )

    const peer = markInitialized(new PeerConnector({ url: PEER_JACK_URL, apiKey: 'peer-api-key', name: 'Friend Jack' }))
    const dir = await mkdtemp(join(tmpdir(), 'jack-peer-completed-callback-'))
    const destPath = join(dir, 'Movie.mkv')
    const partPath = `${destPath}.part`

    try {
      await peer.downloadFile('remote1:movie:99', destPath, {
        onProgress: (event) => {
          if (event.type === 'completed')
            throw new Error('tracking write failed')
        },
      })

      expect(await Bun.file(partPath).exists()).toBe(false)
      expect(new Uint8Array(await Bun.file(destPath).arrayBuffer())).toEqual(new Uint8Array([1, 2, 3, 4]))
    }
    finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('does not leave the response body locked when opening the .part file fails', async () => {
    let body: ReadableStream<Uint8Array> | null = null
    const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(async () => {
      const response = new Response(streamOf([1, 2, 3]), { headers: { 'Content-Length': '3' } })
      body = response.body
      return response
    },
    )

    const peer = markInitialized(new PeerConnector({ url: PEER_JACK_URL, apiKey: 'peer-api-key', name: 'Friend Jack' }))
    const dir = await mkdtemp(join(tmpdir(), 'jack-peer-open-fails-'))
    const destPath = join(dir, 'missing-parent', 'Movie.mkv')

    try {
      await expect(peer.downloadFile('remote1:movie:99', destPath, { partPath: `${destPath}.part`, releaseSize: 3 })).rejects.toThrow()
      expect(body).not.toBeNull()
      expect(body?.locked).toBe(false)
    }
    finally {
      fetchSpy.mockRestore()
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('closes the .part file handle when getting the response reader fails', async () => {
    const before = await openFileDescriptorCount()
    if (before == null)
      return

    const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(async () => {
      return new Response(streamOf([1, 2, 3]), { headers: { 'Content-Length': '3' } })
    })
    const getReaderSpy = spyOn(ReadableStream.prototype, 'getReader').mockImplementation(() => {
      throw new Error('reader failed')
    })

    const peer = markInitialized(new PeerConnector({ url: PEER_JACK_URL, apiKey: 'peer-api-key', name: 'Friend Jack' }))
    const dir = await mkdtemp(join(tmpdir(), 'jack-peer-reader-fails-'))
    const destPath = join(dir, 'Movie.mkv')

    try {
      await expect(peer.downloadFile('remote1:movie:99', destPath, { partPath: `${destPath}.part`, releaseSize: 3 })).rejects.toThrow('reader failed')
      expect(await openFileDescriptorCount()).toBeLessThanOrEqual(before)
    }
    finally {
      getReaderSpy.mockRestore()
      fetchSpy.mockRestore()
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('aborts with IdleTimeoutError when the peer stops sending bytes', async () => {
    // Use a fetch spy so the body stream reliably errors when the connector's
    // idle abort fires (MSW's mock doesn't propagate the fetch signal mid-body).
    // Real fetch rejects an in-flight read on abort, which this mirrors.
    const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(async (_url, init?: RequestInit) => {
      const signal = init?.signal
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([1, 2]))
          // No further chunks → the transfer stalls. Error the stream when the
          // connector aborts (its idle timer), like real fetch would.
          signal?.addEventListener('abort', () => controller.error(new DOMException('aborted', 'AbortError')))
        },
      })
      return new Response(body, { headers: { 'Content-Length': '5' } })
    })

    const peer = markInitialized(new PeerConnector({ url: PEER_JACK_URL, apiKey: 'peer-api-key', name: 'Friend Jack' }))
    const dir = await mkdtemp(join(tmpdir(), 'jack-peer-stall-'))
    const destPath = join(dir, 'Movie.mkv')
    const partPath = `${destPath}.part`

    try {
      await expect(peer.downloadFile('remote1:movie:99', destPath, { partPath, releaseSize: 5, idleTimeoutMs: 50 }))
        .rejects
        .toThrow(IdleTimeoutError)
      expect(await Bun.file(destPath).exists()).toBe(false)
      expect(await Bun.file(partPath).exists()).toBe(true) // preserved for resume
    }
    finally {
      fetchSpy.mockRestore()
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('does not abort a slow but active download (chunks within the idle window)', async () => {
    server.use(
      http.get(`${PEER_JACK_URL}/peer/items/:itemId/file`, () => {
        return new Response(new ReadableStream({
          async start(controller) {
            for (const b of [1, 2, 3, 4]) {
              await Bun.sleep(20)
              controller.enqueue(new Uint8Array([b]))
            }
            controller.close()
          },
        }), { headers: { 'Content-Length': '4' } })
      }),
    )

    const peer = markInitialized(new PeerConnector({ url: PEER_JACK_URL, apiKey: 'peer-api-key', name: 'Friend Jack' }))
    const dir = await mkdtemp(join(tmpdir(), 'jack-peer-slow-'))
    const destPath = join(dir, 'Movie.mkv')

    try {
      await peer.downloadFile('remote1:movie:99', destPath, { partPath: `${destPath}.part`, releaseSize: 4, idleTimeoutMs: 200 })
      expect(new Uint8Array(await Bun.file(destPath).arrayBuffer())).toEqual(new Uint8Array([1, 2, 3, 4]))
    }
    finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('PeerConnector.downloadFile resume', () => {
  test('resumes from an existing .part via a Range request and appends', async () => {
    const seen: { range: string | null } = { range: null }
    server.use(
      http.get(`${PEER_JACK_URL}/peer/items/:itemId/file`, ({ request }) => {
        seen.range = request.headers.get('Range')
        return new Response(streamOf([2, 3, 4]), {
          status: 206,
          headers: { 'Content-Length': '3', 'Content-Range': 'bytes 2-4/5' },
        })
      }),
    )
    const peer = markInitialized(new PeerConnector({ url: PEER_JACK_URL, apiKey: 'peer-api-key', name: 'Friend Jack' }))
    const dir = await mkdtemp(join(tmpdir(), 'jack-resume-'))
    const destPath = join(dir, 'Movie.mkv')
    const partPath = `${destPath}.part`
    await writeFile(partPath, new Uint8Array([0, 1]))
    const events: PeerDownloadProgressEvent[] = []

    try {
      await peer.downloadFile('remote1:movie:99', destPath, {
        partPath,
        releaseSize: 5,
        onProgress: (e) => { events.push(e) },
      })

      expect(seen.range).toBe('bytes=2-')
      expect(new Uint8Array(await Bun.file(destPath).arrayBuffer())).toEqual(new Uint8Array([0, 1, 2, 3, 4]))
      expect(events.some(e => e.type === 'restart')).toBe(false)
      expect(events).toContainEqual({ type: 'completed', downloadedBytes: 5, expectedBytes: 5 })
    }
    finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('restarts from byte 0 when the peer ignores Range and returns 200', async () => {
    server.use(
      http.get(`${PEER_JACK_URL}/peer/items/:itemId/file`, () =>
        new Response(streamOf([0, 1, 2, 3, 4]), { headers: { 'Content-Length': '5' } })),
    )
    const peer = markInitialized(new PeerConnector({ url: PEER_JACK_URL, apiKey: 'peer-api-key', name: 'Friend Jack' }))
    const dir = await mkdtemp(join(tmpdir(), 'jack-resume-ignored-'))
    const destPath = join(dir, 'Movie.mkv')
    const partPath = `${destPath}.part`
    await writeFile(partPath, new Uint8Array([9, 9]))
    const events: PeerDownloadProgressEvent[] = []

    try {
      await peer.downloadFile('remote1:movie:99', destPath, {
        partPath,
        releaseSize: 5,
        onProgress: (e) => { events.push(e) },
      })

      expect(new Uint8Array(await Bun.file(destPath).arrayBuffer())).toEqual(new Uint8Array([0, 1, 2, 3, 4]))
      expect(events.some(e => e.type === 'restart' && e.reason === 'range_ignored')).toBe(true)
    }
    finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('restarts when the 206 Content-Range total does not match releaseSize', async () => {
    server.use(
      http.get(`${PEER_JACK_URL}/peer/items/:itemId/file`, ({ request }) => {
        if (request.headers.get('Range')) {
          return new Response(streamOf([2, 3]), { status: 206, headers: { 'Content-Length': '2', 'Content-Range': 'bytes 2-3/4' } })
        }
        return new Response(streamOf([0, 1, 2, 3, 4]), { headers: { 'Content-Length': '5' } })
      }),
    )
    const peer = markInitialized(new PeerConnector({ url: PEER_JACK_URL, apiKey: 'peer-api-key', name: 'Friend Jack' }))
    const dir = await mkdtemp(join(tmpdir(), 'jack-resume-mismatch-'))
    const destPath = join(dir, 'Movie.mkv')
    const partPath = `${destPath}.part`
    await writeFile(partPath, new Uint8Array([0, 1]))
    const events: PeerDownloadProgressEvent[] = []

    try {
      await peer.downloadFile('remote1:movie:99', destPath, {
        partPath,
        releaseSize: 5,
        onProgress: (e) => { events.push(e) },
      })

      expect(new Uint8Array(await Bun.file(destPath).arrayBuffer())).toEqual(new Uint8Array([0, 1, 2, 3, 4]))
      expect(events.some(e => e.type === 'restart' && e.reason === 'content_range_mismatch')).toBe(true)
    }
    finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('restarts when the peer returns 416 for the resume range (releaseSize unknown)', async () => {
    // releaseSize omitted so the pre-fetch oversize guard is skipped and the
    // Range is actually sent — exercising the 416 restart path.
    server.use(
      http.get(`${PEER_JACK_URL}/peer/items/:itemId/file`, ({ request }) => {
        if (request.headers.get('Range'))
          return new Response(null, { status: 416, headers: { 'Content-Range': 'bytes */5' } })
        return new Response(streamOf([0, 1, 2, 3, 4]), { headers: { 'Content-Length': '5' } })
      }),
    )
    const peer = markInitialized(new PeerConnector({ url: PEER_JACK_URL, apiKey: 'peer-api-key', name: 'Friend Jack' }))
    const dir = await mkdtemp(join(tmpdir(), 'jack-resume-416-'))
    const destPath = join(dir, 'Movie.mkv')
    const partPath = `${destPath}.part`
    await writeFile(partPath, new Uint8Array([0, 1, 2, 3, 4, 5]))
    const events: PeerDownloadProgressEvent[] = []

    try {
      await peer.downloadFile('remote1:movie:99', destPath, {
        partPath,
        onProgress: (e) => { events.push(e) },
      })

      expect(new Uint8Array(await Bun.file(destPath).arrayBuffer())).toEqual(new Uint8Array([0, 1, 2, 3, 4]))
      expect(events.some(e => e.type === 'restart' && e.reason === 'range_not_satisfiable')).toBe(true)
    }
    finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('discards and restarts when the .part is larger than releaseSize', async () => {
    let rangeSent = false
    server.use(
      http.get(`${PEER_JACK_URL}/peer/items/:itemId/file`, ({ request }) => {
        if (request.headers.get('Range'))
          rangeSent = true
        return new Response(streamOf([0, 1, 2, 3, 4]), { headers: { 'Content-Length': '5' } })
      }),
    )
    const peer = markInitialized(new PeerConnector({ url: PEER_JACK_URL, apiKey: 'peer-api-key', name: 'Friend Jack' }))
    const dir = await mkdtemp(join(tmpdir(), 'jack-resume-oversize-'))
    const destPath = join(dir, 'Movie.mkv')
    const partPath = `${destPath}.part`
    await writeFile(partPath, new Uint8Array([0, 1, 2, 3, 4, 5, 6])) // 7 > releaseSize 5
    const events: PeerDownloadProgressEvent[] = []

    try {
      await peer.downloadFile('remote1:movie:99', destPath, {
        partPath,
        releaseSize: 5,
        onProgress: (e) => { events.push(e) },
      })

      expect(rangeSent).toBe(false) // discarded before requesting; fresh download
      expect(events.some(e => e.type === 'restart' && e.reason === 'part_oversize')).toBe(true)
      expect(new Uint8Array(await Bun.file(destPath).arrayBuffer())).toEqual(new Uint8Array([0, 1, 2, 3, 4]))
    }
    finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('finalizes without re-downloading when the .part already equals releaseSize', async () => {
    let fetched = false
    server.use(
      http.get(`${PEER_JACK_URL}/peer/items/:itemId/file`, () => {
        fetched = true
        return new Response(streamOf([0, 1, 2]), { headers: { 'Content-Length': '3' } })
      }),
    )
    const peer = markInitialized(new PeerConnector({ url: PEER_JACK_URL, apiKey: 'peer-api-key', name: 'Friend Jack' }))
    const dir = await mkdtemp(join(tmpdir(), 'jack-resume-exact-'))
    const destPath = join(dir, 'Movie.mkv')
    const partPath = `${destPath}.part`
    await writeFile(partPath, new Uint8Array([7, 8, 9])) // 3 === releaseSize 3
    const events: PeerDownloadProgressEvent[] = []

    try {
      await peer.downloadFile('remote1:movie:99', destPath, {
        partPath,
        releaseSize: 3,
        onProgress: (e) => { events.push(e) },
      })

      expect(fetched).toBe(false) // no HTTP request at all
      expect(await Bun.file(partPath).exists()).toBe(false)
      expect(new Uint8Array(await Bun.file(destPath).arrayBuffer())).toEqual(new Uint8Array([7, 8, 9]))
      expect(events).toContainEqual({ type: 'headers', expectedBytes: 3, expectedBytesSource: 'release_size', expectedBytesMismatch: false })
      expect(events).toContainEqual({ type: 'completed', downloadedBytes: 3, expectedBytes: 3 })
    }
    finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('rejects non-ok resume responses without appending the response body', async () => {
    server.use(
      http.get(`${PEER_JACK_URL}/peer/items/:itemId/file`, () =>
        new Response(streamOf([9, 9]), { status: 500, statusText: 'Server Error', headers: { 'Content-Length': '2' } })),
    )
    const peer = markInitialized(new PeerConnector({ url: PEER_JACK_URL, apiKey: 'peer-api-key', name: 'Friend Jack' }))
    const dir = await mkdtemp(join(tmpdir(), 'jack-resume-non-ok-'))
    const destPath = join(dir, 'Movie.mkv')
    const partPath = `${destPath}.part`
    await writeFile(partPath, new Uint8Array([0, 1]))

    try {
      await expect(peer.downloadFile('remote1:movie:99', destPath, { partPath, releaseSize: 5 })).rejects.toThrow('Failed to resume download from peer')
      expect(await Bun.file(partPath).exists()).toBe(true)
      expect(new Uint8Array(await Bun.file(partPath).arrayBuffer())).toEqual(new Uint8Array([0, 1]))
      expect(await Bun.file(destPath).exists()).toBe(false)
    }
    finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('preserves the .part file when a download fails mid-stream', async () => {
    server.use(
      http.get(`${PEER_JACK_URL}/peer/items/:itemId/file`, () =>
        // Declares 5 bytes but only delivers 3 → "Incomplete file download".
        new Response(streamOf([0, 1, 2]), { headers: { 'Content-Length': '5' } })),
    )
    const peer = markInitialized(new PeerConnector({ url: PEER_JACK_URL, apiKey: 'peer-api-key', name: 'Friend Jack' }))
    const dir = await mkdtemp(join(tmpdir(), 'jack-resume-preserve-'))
    const destPath = join(dir, 'Movie.mkv')
    const partPath = `${destPath}.part`

    try {
      await expect(peer.downloadFile('remote1:movie:99', destPath, { partPath, releaseSize: 5 })).rejects.toThrow('Incomplete')
      expect(await Bun.file(partPath).exists()).toBe(true)
      expect(Bun.file(partPath).size).toBe(3)
      expect(await Bun.file(destPath).exists()).toBe(false)
    }
    finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('rejects a 206 returned for a non-range (fresh) request', async () => {
    server.use(
      http.get(`${PEER_JACK_URL}/peer/items/:itemId/file`, () =>
        // No .part exists, so no Range is sent — a 206 here is untrustworthy.
        new Response(streamOf([2, 3, 4]), { status: 206, headers: { 'Content-Length': '3', 'Content-Range': 'bytes 2-4/5' } })),
    )
    const peer = markInitialized(new PeerConnector({ url: PEER_JACK_URL, apiKey: 'peer-api-key', name: 'Friend Jack' }))
    const dir = await mkdtemp(join(tmpdir(), 'jack-resume-206-fresh-'))
    const destPath = join(dir, 'Movie.mkv')

    try {
      await expect(peer.downloadFile('remote1:movie:99', destPath, { partPath: `${destPath}.part`, releaseSize: 5 })).rejects.toThrow('206')
      expect(await Bun.file(destPath).exists()).toBe(false)
    }
    finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
