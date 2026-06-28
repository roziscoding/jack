import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { http, HttpResponse } from 'msw'
import { setupServer } from 'msw/node'
import { PeerConnector } from '../lib/servers/peer'
import { getManagementApp } from '../management-app'

const server = setupServer()
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

function makePeer(url = 'http://peer.test') {
  return new PeerConnector({ url, apiKey: 'peer-key', name: 'Friend Jack' })
}

describe('PeerConnector handshake compatibility', () => {
  test('initializes against a compatible peer, sends its api key, and records its version', async () => {
    const seenHeaders: Record<string, string | null> = {}
    server.use(
      http.get('http://peer.test/handshake', ({ request }) => {
        seenHeaders.apiKey = request.headers.get('x-api-key')
        return HttpResponse.json({ name: 'jack', version: '0.1.0' })
      }),
    )
    const peer = makePeer()
    peer.init()
    await peer.initialization

    expect(peer.isInitialized).toBe(true)
    expect(peer.peerVersion).toBe('0.1.0')
    expect(peer.initializationError).toBeNull()
    expect(seenHeaders.apiKey).toBe('peer-key')
  })

  test('fails on a peer whose version is below the minimum', async () => {
    server.use(
      http.get('http://peer.test/handshake', () => HttpResponse.json({ name: 'jack', version: '0.0.9' })),
    )
    const peer = makePeer()
    peer.init()
    await peer.initialization.catch(() => {})

    expect(peer.isInitialized).toBe(false)
    expect(peer.initializationError).toContain('incompatible peer-protocol version')
    expect(peer.initializationError).toContain('got 0.0.9')
  })

  test('fails when the handshake has no version field', async () => {
    server.use(
      http.get('http://peer.test/handshake', () => HttpResponse.json({ name: 'jack' })),
    )
    const peer = makePeer()
    peer.init()
    await peer.initialization.catch(() => {})

    expect(peer.isInitialized).toBe(false)
    expect(peer.initializationError).toContain('got none')
  })

  test('fails when the handshake version is malformed (null / non-string)', async () => {
    server.use(
      http.get('http://peer.test/handshake', () => HttpResponse.json({ name: 'jack', version: null })),
    )
    const peer = makePeer()
    peer.init()
    await peer.initialization.catch(() => {})

    expect(peer.isInitialized).toBe(false)
    expect(peer.initializationError).toContain('incompatible peer-protocol version')
    expect(peer.initializationError).toContain('got none')
  })

  test('treats an old peer with no /handshake route (404) as incompatible', async () => {
    server.use(
      http.get('http://peer.test/handshake', () => new HttpResponse(null, { status: 404 })),
    )
    const peer = makePeer()
    peer.init()
    await peer.initialization.catch(() => {})

    expect(peer.isInitialized).toBe(false)
    expect(peer.initializationError).toContain('incompatible peer-protocol version')
  })

  test('propagates an auth failure without claiming a version mismatch', async () => {
    server.use(
      http.get('http://peer.test/handshake', () => new HttpResponse(null, { status: 401 })),
    )
    const peer = makePeer()
    peer.init()
    await peer.initialization.catch(() => {})

    expect(peer.isInitialized).toBe(false)
    expect(peer.initializationError).not.toContain('incompatible peer-protocol version')
  })
})

describe('peer version is surfaced on the management API', () => {
  test('GET /config/peers exposes each peer reported version', async () => {
    server.use(
      http.get('http://peer.test/handshake', () => HttpResponse.json({ name: 'jack', version: '0.1.0' })),
    )
    const peer = makePeer()
    peer.init()
    await peer.initialization

    // Connector listing lives only on the management API (it exposes peer
    // names/urls, which the peer-facing app must not).
    const app = getManagementApp({ environment: 'test', managementKey: 'mgmt-secret', connectors: { servers: [], peers: [peer] } })

    const res = await app.request('/config/peers', { headers: { 'X-Management-Key': 'mgmt-secret' } })
    expect(res.status).toBe(200)
    const body = await res.json() as { peers: Array<{ name: string, version: string | null }> }
    expect(body.peers).toHaveLength(1)
    expect(body.peers[0]).toMatchObject({ name: 'Friend Jack', version: '0.1.0' })
  })
})
