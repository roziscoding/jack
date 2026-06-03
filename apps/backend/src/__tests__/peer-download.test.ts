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

    server.use(
      http.get(`${PEER_JACK_URL}/peer/items/:itemId/file`, () => {
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

    const peer = markInitialized(new PeerConnector({ url: PEER_JACK_URL, apiKey: 'peer-api-key', name: 'Friend Jack' }))
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
    }
    finally {
      releaseSecondChunk.resolve()
      await rm(dir, { recursive: true, force: true })
    }
  })
})
