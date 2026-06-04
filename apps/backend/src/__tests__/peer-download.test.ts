import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { http, HttpResponse } from 'msw'
import { setupServer } from 'msw/node'
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

  test('reports indeterminate expected bytes when Content-Length is missing or invalid', async () => {
    for (const contentLength of [null, 'not-a-number']) {
      server.resetHandlers()
      server.use(
        http.get(`${PEER_JACK_URL}/peer/items/:itemId/file`, () => {
          const headers = contentLength == null ? {} : { 'Content-Length': contentLength }
          return new Response(streamOf([1, 2]), { headers })
        }),
      )

      const peer = markInitialized(new PeerConnector({ url: PEER_JACK_URL, apiKey: 'peer-api-key', name: 'Friend Jack' }))
      const dir = await mkdtemp(join(tmpdir(), 'jack-peer-indeterminate-'))
      const events: unknown[] = []

      try {
        await peer.downloadFile('remote1:movie:99', join(dir, 'Movie.mkv'), {
          onProgress: (event) => { events.push(event) },
        })

        expect(events).toContainEqual({ type: 'headers', expectedBytes: null, expectedBytesSource: null, expectedBytesMismatch: false })
        expect(events).toContainEqual({ type: 'completed', downloadedBytes: 2, expectedBytes: null })
      }
      finally {
        await rm(dir, { recursive: true, force: true })
      }
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
})
