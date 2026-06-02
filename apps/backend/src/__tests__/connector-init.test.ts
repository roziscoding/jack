import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { http, HttpResponse } from 'msw'
import { setupServer } from 'msw/node'
import { RadarrServerConnector } from '../lib/servers/arr/radarr'
import { PeerController } from '../modules/peer/peer.controller'

const HEX_KEY = 'a'.repeat(32)

// Minimal movie with a file on disk — enough for Radarr.toRelease to emit one Release.
const mockMovie = {
  id: 1,
  title: 'The Matrix',
  hasFile: true,
  imdbId: 'tt0133093',
  movieFile: {
    id: 11,
    path: '/media/The.Matrix.1999.mkv',
    size: 2_000_000_000,
    quality: { quality: { name: 'Bluray-1080p' } },
  },
}

function makeRadarr(url: string) {
  return new RadarrServerConnector({
    url,
    apiKey: HEX_KEY,
    name: `radarr@${url}`,
    source: true,
    destination: false,
    autoregister: { enable: false, priority: 1 },
  })
}

const server = setupServer()
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

describe('connector init() state machine', () => {
  test('retries after a failed init, then stops pinging once initialized', async () => {
    let pings = 0
    let healthy = false
    server.use(
      http.get('http://arr.test/api/v3/system/status', () => {
        pings++
        return healthy
          ? HttpResponse.json({ appName: 'Radarr', version: '5.0' })
          : new HttpResponse('down', { status: 503 })
      }),
    )
    const radarr = makeRadarr('http://arr.test')

    // 1st attempt: fails, pinged once.
    radarr.init()
    await expect(radarr.initialization!).rejects.toThrow()
    expect(pings).toBe(1)
    expect(radarr.isInitialized).toBe(false)

    // Still down: a fresh call re-pings (retry).
    radarr.init()
    await expect(radarr.initialization!).rejects.toThrow()
    expect(pings).toBe(2)

    // Recovered: retry succeeds.
    healthy = true
    radarr.init()
    await radarr.initialization
    expect(pings).toBe(3)
    expect(radarr.isInitialized).toBe(true)

    // Already initialized: init() is a no-op, no extra ping.
    radarr.init()
    await radarr.initialization
    expect(pings).toBe(3)
  })

  test('does not re-ping while an init is already in flight', async () => {
    let pings = 0
    server.use(
      http.get('http://inflight.test/api/v3/system/status', async () => {
        pings++
        await new Promise(r => setTimeout(r, 50))
        return HttpResponse.json({ appName: 'Radarr', version: '5.0' })
      }),
    )
    const radarr = makeRadarr('http://inflight.test')

    // Two back-to-back init() calls while the first ping is still pending.
    radarr.init()
    radarr.init()
    await radarr.initialization

    expect(pings).toBe(1)
    expect(radarr.isInitialized).toBe(true)
  })
})

describe('search resilience + lazy retry', () => {
  test('a failing source is isolated; a healthy source still returns results', async () => {
    server.use(
      http.get('http://good.test/api/v3/system/status', () => HttpResponse.json({ appName: 'Radarr', version: '5.0' })),
      http.get('http://good.test/api/v3/movie', () => HttpResponse.json([mockMovie])),
      // initializes fine, but the actual search errors
      http.get('http://broken.test/api/v3/system/status', () => HttpResponse.json({ appName: 'Radarr', version: '5.0' })),
      http.get('http://broken.test/api/v3/movie', () => new HttpResponse('boom', { status: 500 })),
    )
    const controller = new PeerController([makeRadarr('http://good.test'), makeRadarr('http://broken.test')])

    const results = await controller.search({ q: '' })

    expect(results).toHaveLength(1)
    expect(results[0]?.imdbId).toBe('tt0133093')
  })

  test('a source down at boot is still attempted (no isInitialized pre-filter) and skipped on failure', async () => {
    server.use(
      http.get('http://up.test/api/v3/system/status', () => HttpResponse.json({ appName: 'Radarr', version: '5.0' })),
      http.get('http://up.test/api/v3/movie', () => HttpResponse.json([mockMovie])),
      http.get('http://down.test/api/v3/system/status', () => new HttpResponse('down', { status: 503 })),
    )
    const up = makeRadarr('http://up.test')
    const down = makeRadarr('http://down.test')
    // Neither has been initialized — the old code would filter both out.
    const controller = new PeerController([up, down])

    const results = await controller.search({ q: '' })

    expect(results).toHaveLength(1)
    expect(down.isInitialized).toBe(false)
  })

  test('a source that recovers rejoins the next search without a restart', async () => {
    let healthy = false
    server.use(
      http.get('http://flaky.test/api/v3/system/status', () =>
        healthy
          ? HttpResponse.json({ appName: 'Radarr', version: '5.0' })
          : new HttpResponse('down', { status: 503 })),
      http.get('http://flaky.test/api/v3/movie', () => HttpResponse.json([mockMovie])),
    )
    const flaky = makeRadarr('http://flaky.test')
    const controller = new PeerController([flaky])

    // Down at boot → first search gets nothing.
    expect(await controller.search({ q: '' })).toHaveLength(0)
    expect(flaky.isInitialized).toBe(false)

    // Server comes back → next search re-initializes lazily and returns results.
    healthy = true
    expect(await controller.search({ q: '' })).toHaveLength(1)
    expect(flaky.isInitialized).toBe(true)
  })
})

describe('fetch timeout', () => {
  test('aborts a hung request after the configured timeout', async () => {
    server.use(
      http.get('http://hung.test/api/v3/system/status', async () => {
        await new Promise(r => setTimeout(r, 2000))
        return HttpResponse.json({ appName: 'Radarr', version: '5.0' })
      }),
    )
    const radarr = makeRadarr('http://hung.test')

    const start = Date.now()
    // Reach the protected fetch with a short per-call timeout.
    const call = (radarr as unknown as { fetch: (p: string, i: object) => Promise<unknown> })
      .fetch('/api/v3/system/status', { method: 'GET', timeoutMs: 100 })

    await expect(call).rejects.toThrow()
    // It must give up around the timeout, well before the 2s the server waits.
    expect(Date.now() - start).toBeLessThan(1000)
  })
})
