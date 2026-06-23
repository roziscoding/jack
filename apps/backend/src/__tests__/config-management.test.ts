import type { Envs } from '../lib/envs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { jsonc } from 'jsonc'
import { http, HttpResponse } from 'msw'
import { setupServer } from 'msw/node'
import { getApp } from '../app'
import { runMigrations } from '../database/connection'
import * as schema from '../database/schema'
import { AppConfig, MIGRATIONS } from '../lib/config'
import { ConnectorManager } from '../lib/servers'
import { generateId } from '../lib/servers/base'
import { PeerConnector } from '../lib/servers/peer'
import { PROTOCOL_VERSION } from '../lib/version'
import { getManagementApp } from '../management-app'
import { ConfigService } from '../modules/config/config.service'
import { DownloadsRepository } from '../modules/downloads/downloads.repository'

const config = AppConfig.parse({
  version: MIGRATIONS.length,
  jack: { baseUrl: 'http://localhost:3000', apiKey: 'test-api-key' },
  downloads: { completedPath: '/tmp/jack-test-completed' },
  servers: [],
  peers: [],
})

function makeEnvs(managementKey?: string): Envs {
  return {
    APP_CONFIG_PATH: '/data/config.json',
    ENABLE_LOGS: false,
    ENVIRONMENT: 'test' as any,
    HTTP_TIMEOUT_MS: 3000,
    LOG_LEVEL: 'fatal',
    OTEL_SERVICE_NAME: 'jack-server',
    PORT: 3000,
    MANAGEMENT_PORT: 5226,
    NODE_ENV: 'test',
    MANAGEMENT_KEY: managementKey,
  }
}

function markInitialized<T extends object>(connector: T): T {
  const c = connector as any
  c._isInitialized = true
  c._initState = 'initialized'
  c._initialization.resolve()
  return connector
}

function makePeer() {
  return markInitialized(new PeerConnector({ url: 'http://peer.test:3000', apiKey: 'peer-api-key', name: 'Friend Jack' }))
}

function mgmtApp(managementKey = 'mgmt-secret', peers = [makePeer()]) {
  return getManagementApp({ environment: 'test', managementKey, connectors: { servers: [], peers } })
}

describe('Management API auth', () => {
  test('GET /config/peers with valid key returns 200 + peers', async () => {
    const res = await mgmtApp().request('/config/peers', { headers: { 'X-Management-Key': 'mgmt-secret' } })
    expect(res.status).toBe(200)
    const body = await res.json() as { peers: Array<{ name: string }> }
    expect(body.peers[0]?.name).toBe('Friend Jack')
  })

  test('GET /config/peers without key returns 401', async () => {
    const res = await mgmtApp().request('/config/peers')
    expect(res.status).toBe(401)
  })

  test('GET /config/peers with wrong key returns 401', async () => {
    const res = await mgmtApp().request('/config/peers', { headers: { 'X-Management-Key': 'wrong' } })
    expect(res.status).toBe(401)
  })

  test('the public app never exposes /config', async () => {
    const app = getApp(makeEnvs(undefined), config, { servers: [], peers: [makePeer()] } as any)
    // Carry a valid peer API key so we get past requireApiKey and reach routing:
    // a true 404 proves the route is unregistered, not merely auth-blocked.
    const res = await app.request('/config', { headers: { 'x-api-key': 'test-api-key' } })
    expect(res.status).toBe(404)
  })

  test('mutation routes are absent (404) when no ConfigService is wired', async () => {
    // mgmtApp() injects no configService → canMutate is false → POST is unregistered.
    const res = await mgmtApp().request('/config/peers', {
      method: 'POST',
      headers: { 'X-Management-Key': 'mgmt-secret', 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Bob', url: 'http://bob.test:3000', apiKey: 'k' }),
    })
    expect(res.status).toBe(404)
  })
})

const mswServer = setupServer(
  http.get('http://bob.test:3000/handshake', () => HttpResponse.json({ name: 'jack', version: PROTOCOL_VERSION })),
  http.get('http://bob.test:3000/peer/search', () => HttpResponse.json({ items: [
    { id: 'b:movie:1', title: 'Bob.Movie.1080p', filename: 'Bob.Movie.1080p.mkv', category: 2000, size: 1, imdbId: 'tt1', tmdbId: 1 },
  ] })),
  http.get('http://bob2.test:3000/handshake', () => HttpResponse.json({ name: 'jack', version: PROTOCOL_VERSION })),
  http.get('http://carol.test:3000/handshake', () => HttpResponse.json({ name: 'jack', version: PROTOCOL_VERSION })),
  // A peer that's reachable but rejects auth — its handshake 401s, so init fails.
  http.get('http://dead.test:3000/handshake', () => new HttpResponse(null, { status: 401 })),
  http.get('http://radarr-new.test:7878/api/v3/system/status', () => HttpResponse.json({ appName: 'Radarr', version: '4.0.0' })),
  // A server that's reachable but rejects auth — its status check 401s, so init fails.
  http.get('http://dead-radarr.test:7878/api/v3/system/status', () => new HttpResponse(null, { status: 401 })),
)
beforeAll(() => mswServer.listen({ onUnhandledRequest: 'bypass' }))
afterAll(() => mswServer.close())

const tempFiles: string[] = []
const dbsToClose: Database[] = []
afterEach(async () => {
  for (const f of tempFiles.splice(0))
    await rm(f, { force: true })
  for (const db of dbsToClose.splice(0))
    db.close()
})

// `app` is the MANAGEMENT app (where /config lives); `mainApp` is the public peer
// app (where /torznab etc. live). Both share the same in-process connectorManager +
// configService, so a mutation on `app` is visible to `mainApp` (see Phase 7).
async function makeMutableApp(managementKey = 'mgmt-secret') {
  const path = join(tmpdir(), `jack-config-${Math.random().toString(36).slice(2)}.jsonc`)
  tempFiles.push(path)
  await Bun.write(path, jsonc.stringify({ version: 1, peers: [], servers: [] }, { space: 2 }))
  const connectorManager = new ConnectorManager([], [])
  const database = new Database(':memory:')
  dbsToClose.push(database)
  database.exec('pragma foreign_keys = ON')
  const db = drizzle({ client: database, schema })
  runMigrations(db)
  const downloadsRepository = new DownloadsRepository(db)
  const configService = await ConfigService.fromFile({ path, connectorManager, downloadsRepository })
  const app = getManagementApp({ environment: 'test', managementKey, connectors: connectorManager, configService })
  const mainApp = getApp(makeEnvs(managementKey), config, connectorManager, { downloadsRepository })
  return { app, mainApp, path, connectorManager, downloadsRepository, database }
}

const KEY = { 'X-Management-Key': 'mgmt-secret' } as const

describe('ConnectorManager enabled filtering', () => {
  test('peers getter excludes a disabled peer but the connector stays resident', () => {
    const peer = makePeer()
    const manager = new ConnectorManager([], [])
    // Inject the peer into the live map, then disable it.
    ;(manager as any)._peerMap.set(peer.id, peer)
    expect(manager.peers).toHaveLength(1)

    manager.removeConnector(peer.id)
    expect(manager.peers).toHaveLength(0)
    // Still resident in the internal map (for in-flight drain).
    expect((manager as any)._peerMap.get(peer.id)).toBe(peer)
    expect(peer.enabled).toBe(false)
  })
})

describe('Management API addPeer', () => {
  test('adds a peer live and preserves the secret ref in the file', async () => {
    process.env.BOB_KEY = 'bob-secret'
    const { app, path, connectorManager } = await makeMutableApp()

    const res = await app.request('/config/peers', {
      method: 'POST',
      headers: { ...KEY, 'Content-Type': 'application/json' },
      // `bogus` is an unknown field — it must be stripped before persisting.
      body: JSON.stringify({ name: 'Bob', url: 'http://bob.test:3000', apiKey: { env: 'BOB_KEY' }, bogus: 'x' }),
    })
    expect(res.status).toBe(201)

    const onDisk = jsonc.parse(await Bun.file(path).text()) as { peers: Array<{ apiKey: unknown, bogus?: unknown }> }
    expect(onDisk.peers[0]?.apiKey).toEqual({ env: 'BOB_KEY' })
    expect(onDisk.peers[0]?.bogus).toBeUndefined()
    expect(connectorManager.peers.some(p => p.url === 'http://bob.test:3000')).toBe(true)
  })

  test('rejects a duplicate url with 409', async () => {
    process.env.BOB_KEY = 'bob-secret'
    const { app } = await makeMutableApp()
    const body = JSON.stringify({ name: 'Bob', url: 'http://bob.test:3000', apiKey: 'k' })
    await app.request('/config/peers', { method: 'POST', headers: { ...KEY, 'Content-Type': 'application/json' }, body })
    const res = await app.request('/config/peers', { method: 'POST', headers: { ...KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Bob2', url: 'http://bob.test:3000', apiKey: 'k' }) })
    expect(res.status).toBe(409)
  })

  test('a peer that fails its handshake is not persisted and the error is returned', async () => {
    const { app, path, connectorManager } = await makeMutableApp()

    const res = await app.request('/config/peers', {
      method: 'POST',
      headers: { ...KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Dead', url: 'http://dead.test:3000', apiKey: 'k' }),
    })
    // The connectivity check failed → the add is rejected, not a silent 201.
    expect(res.status).toBe(502)
    const body = await res.json() as { ok: boolean, error: { message: string } }
    expect(body.ok).toBe(false)
    expect(body.error.message).toContain('Dead')

    // Rolled back: nothing on disk, nothing resident in the connector map.
    const onDisk = jsonc.parse(await Bun.file(path).text()) as { peers: unknown[] }
    expect(onDisk.peers).toHaveLength(0)
    expect(connectorManager.peers.some(p => p.url === 'http://dead.test:3000')).toBe(false)
    expect((connectorManager as any)._peerMap.has(generateId('http://dead.test:3000'))).toBe(false)
  })

  test('rejects an invalid body with 400', async () => {
    const { app } = await makeMutableApp()
    const res = await app.request('/config/peers', { method: 'POST', headers: { ...KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'NoUrl' }) })
    expect(res.status).toBe(400)
  })

  test('serializes concurrent adds without losing an update', async () => {
    const { app, path } = await makeMutableApp()
    await Promise.all([
      app.request('/config/peers', { method: 'POST', headers: { ...KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Bob', url: 'http://bob.test:3000', apiKey: 'k' }) }),
      app.request('/config/peers', { method: 'POST', headers: { ...KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Carol', url: 'http://carol.test:3000', apiKey: 'k' }) }),
    ])
    const onDisk = jsonc.parse(await Bun.file(path).text()) as { peers: unknown[] }
    expect(onDisk.peers).toHaveLength(2)
  })
})

describe('Management API remove/update peer', () => {
  const BOB = { name: 'Bob', url: 'http://bob.test:3000', apiKey: 'k' }
  const bobId = generateId(BOB.url)

  async function addBob(app: Awaited<ReturnType<typeof makeMutableApp>>['app']) {
    return app.request('/config/peers', { method: 'POST', headers: { ...KEY, 'Content-Type': 'application/json' }, body: JSON.stringify(BOB) })
  }

  test('removePeer drops it from file and fan-out', async () => {
    const { app, path, connectorManager } = await makeMutableApp()
    await addBob(app)

    const res = await app.request(`/config/peers/${bobId}`, { method: 'DELETE', headers: KEY })
    expect(res.status).toBe(200)

    const onDisk = jsonc.parse(await Bun.file(path).text()) as { peers: unknown[] }
    expect(onDisk.peers).toHaveLength(0)
    expect(connectorManager.peers).toHaveLength(0)
  })

  test('updatePeer renames in file and live connector (same id)', async () => {
    const { app, path, connectorManager } = await makeMutableApp()
    await addBob(app)

    const res = await app.request(`/config/peers/${bobId}`, {
      method: 'PATCH',
      headers: { ...KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...BOB, name: 'Bobby' }),
    })
    expect(res.status).toBe(200)

    const onDisk = jsonc.parse(await Bun.file(path).text()) as { peers: Array<{ name: string }> }
    expect(onDisk.peers[0]?.name).toBe('Bobby')
    expect(connectorManager.peers.find(p => p.id === bobId)?.name).toBe('Bobby')
  })

  test('an update whose new url fails its handshake rolls back', async () => {
    const { app, path, connectorManager } = await makeMutableApp()
    await addBob(app)

    // Re-point Bob at a peer that 401s its handshake — the edit must be rejected.
    const res = await app.request(`/config/peers/${bobId}`, {
      method: 'PATCH',
      headers: { ...KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Bob', url: 'http://dead.test:3000', apiKey: 'k' }),
    })
    expect(res.status).toBe(502)

    // Rolled back: still the working Bob on disk and resident in the map, no dead entry.
    const onDisk = jsonc.parse(await Bun.file(path).text()) as { peers: Array<{ url: string }> }
    expect(onDisk.peers).toHaveLength(1)
    expect(onDisk.peers[0]?.url).toBe('http://bob.test:3000')
    expect(connectorManager.peers.some(p => p.id === bobId)).toBe(true)
    expect((connectorManager as any)._peerMap.has(generateId('http://dead.test:3000'))).toBe(false)
  })

  test('removePeer with unknown id returns 404', async () => {
    const { app } = await makeMutableApp()
    const res = await app.request('/config/peers/deadbeef', { method: 'DELETE', headers: KEY })
    expect(res.status).toBe(404)
  })
})

describe('Management API servers', () => {
  const SERVER = {
    name: 'Radarr',
    url: 'http://radarr-new.test:7878',
    apiKey: 'a'.repeat(32),
    type: 'radarr',
    source: true,
    destination: true,
  }
  const serverId = generateId(SERVER.url)

  test('adds a server live and registers it as a source/destination', async () => {
    const { app, path, connectorManager } = await makeMutableApp()
    const res = await app.request('/config/servers', { method: 'POST', headers: { ...KEY, 'Content-Type': 'application/json' }, body: JSON.stringify(SERVER) })
    expect(res.status).toBe(201)

    const onDisk = jsonc.parse(await Bun.file(path).text()) as { servers: unknown[] }
    expect(onDisk.servers).toHaveLength(1)
    expect(connectorManager.servers.some(s => s.id === serverId)).toBe(true)
    expect(connectorManager.sources.some(s => s.id === serverId)).toBe(true)
  })

  test('removes a server', async () => {
    const { app, connectorManager } = await makeMutableApp()
    await app.request('/config/servers', { method: 'POST', headers: { ...KEY, 'Content-Type': 'application/json' }, body: JSON.stringify(SERVER) })
    const res = await app.request(`/config/servers/${serverId}`, { method: 'DELETE', headers: KEY })
    expect(res.status).toBe(200)
    expect(connectorManager.servers).toHaveLength(0)
  })

  test('a server that fails its status check is not persisted and the error is returned', async () => {
    const { app, path, connectorManager } = await makeMutableApp()
    const deadId = generateId('http://dead-radarr.test:7878')
    const res = await app.request('/config/servers', {
      method: 'POST',
      headers: { ...KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...SERVER, name: 'DeadRadarr', url: 'http://dead-radarr.test:7878' }),
    })
    expect(res.status).toBe(502)
    const body = await res.json() as { ok: boolean, error: { message: string } }
    expect(body.ok).toBe(false)
    expect(body.error.message).toContain('DeadRadarr')

    // Rolled back across every slice: file, server map, and the source/destination lists.
    const onDisk = jsonc.parse(await Bun.file(path).text()) as { servers: unknown[] }
    expect(onDisk.servers).toHaveLength(0)
    expect(connectorManager.servers.some(s => s.id === deadId)).toBe(false)
    expect(connectorManager.sources.some(s => s.id === deadId)).toBe(false)
    expect(connectorManager.destinations.some(s => s.id === deadId)).toBe(false)
  })

  test('an update whose new url fails its status check rolls back', async () => {
    const { app, path, connectorManager } = await makeMutableApp()
    await app.request('/config/servers', { method: 'POST', headers: { ...KEY, 'Content-Type': 'application/json' }, body: JSON.stringify(SERVER) })

    const res = await app.request(`/config/servers/${serverId}`, {
      method: 'PATCH',
      headers: { ...KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...SERVER, url: 'http://dead-radarr.test:7878' }),
    })
    expect(res.status).toBe(502)

    // Rolled back: the working server keeps its url and stays a live source/destination.
    const onDisk = jsonc.parse(await Bun.file(path).text()) as { servers: Array<{ url: string }> }
    expect(onDisk.servers[0]?.url).toBe('http://radarr-new.test:7878')
    expect(connectorManager.servers.some(s => s.id === serverId)).toBe(true)
    expect(connectorManager.sources.some(s => s.id === serverId)).toBe(true)
    expect(connectorManager.destinations.some(s => s.id === serverId)).toBe(true)
  })
})

describe('Management API GET /config exposes refs-intact secrets', () => {
  test('returns the persisted apiKey + header refs without resolving them', async () => {
    process.env.PEER_KEY = 'peer-secret'
    process.env.PEER_HEADER = 'header-secret'
    const { app } = await makeMutableApp()

    await app.request('/config/peers', {
      method: 'POST',
      headers: { ...KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Bob',
        url: 'http://bob.test:3000',
        apiKey: { env: 'PEER_KEY' },
        headers: { 'X-Plain': 'literal', 'X-Secret': { env: 'PEER_HEADER' } },
      }),
    })

    const res = await app.request('/config/peers', { headers: KEY })
    expect(res.status).toBe(200)
    const body = await res.json() as { peers: Array<{ apiKey: unknown, headers: Record<string, unknown> }> }
    // Refs come back exactly as stored — never resolved into the secret value.
    expect(body.peers[0]?.apiKey).toEqual({ env: 'PEER_KEY' })
    expect(body.peers[0]?.headers).toEqual({ 'X-Plain': 'literal', 'X-Secret': { env: 'PEER_HEADER' } })
  })

  test('read-only app (no ConfigService) omits the secret fields', async () => {
    // mgmtApp() wires no ConfigService, so there is no refs-intact source to read
    // from — apiKey/headers are absent rather than resolved off the live connector.
    const res = await mgmtApp().request('/config/peers', { headers: KEY })
    const body = await res.json() as { peers: Array<Record<string, unknown>> }
    expect(body.peers[0]).not.toHaveProperty('apiKey')
    expect(body.peers[0]).not.toHaveProperty('headers')
  })

  test('servers expose every editable field: apiKey ref + headers + autoregister', async () => {
    process.env.SERVER_KEY = 'a'.repeat(32)
    const { app } = await makeMutableApp()

    await app.request('/config/servers', {
      method: 'POST',
      headers: { ...KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Radarr',
        url: 'http://radarr-new.test:7878',
        apiKey: { env: 'SERVER_KEY' },
        type: 'radarr',
        headers: { 'X-Trace': 'on' },
        autoregister: { enable: true, priority: 7 },
      }),
    })

    const res = await app.request('/config/servers', { headers: KEY })
    expect(res.status).toBe(200)
    const body = await res.json() as { servers: Array<{ apiKey: unknown, headers: unknown, autoregister: unknown, source: boolean, destination: boolean }> }
    expect(body.servers[0]?.apiKey).toEqual({ env: 'SERVER_KEY' })
    expect(body.servers[0]?.headers).toEqual({ 'X-Trace': 'on' })
    // autoregister is the effective (defaults-applied) value off the live connector.
    expect(body.servers[0]?.autoregister).toEqual({ enable: true, priority: 7 })
  })
})

describe('Management API live visibility', () => {
  test('a live-added peer is searchable via /torznab without restart', async () => {
    // `app` = management app (/config); `mainApp` = public app (/torznab). Same
    // in-process connectorManager, so a mutation on one is visible to the other.
    const { app, mainApp } = await makeMutableApp()

    // Before: empty feed (queried on the PUBLIC app).
    const before = await (await mainApp.request('/torznab/api?t=search&apikey=test-api-key')).text()
    expect(before).not.toContain('Bob.Movie.1080p')

    // Add via the MANAGEMENT app.
    await app.request('/config/peers', { method: 'POST', headers: { ...KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Bob', url: 'http://bob.test:3000', apiKey: 'k' }) })

    // After add: the peer's catalog appears live on the public feed.
    const after = await (await mainApp.request('/torznab/api?t=search&apikey=test-api-key')).text()
    expect(after).toContain('Bob.Movie.1080p')

    // After remove: gone again.
    const { generateId } = await import('../lib/servers/base')
    await app.request(`/config/peers/${generateId('http://bob.test:3000')}`, { method: 'DELETE', headers: KEY })
    const removed = await (await mainApp.request('/torznab/api?t=search&apikey=test-api-key')).text()
    expect(removed).not.toContain('Bob.Movie.1080p')
  })

  test('a live-added peer appears in GET /servers without restart', async () => {
    // Covers the lazy-getter-OBJECT wiring (ServersController). Together with the
    // /torznab test above (the () => Connector[] PROVIDER wiring), both Phase-7
    // wiring styles are exercised — ItemsController/QbittorrentController reuse the
    // same object-getter pattern as ServersController.
    const { app, mainApp } = await makeMutableApp()

    const before = await (await mainApp.request('/servers', { headers: { 'X-Api-Key': 'test-api-key' } })).json() as { peers: Array<{ name: string }> }
    expect(before.peers.some(p => p.name === 'Bob')).toBe(false)

    await app.request('/config/peers', { method: 'POST', headers: { ...KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Bob', url: 'http://bob.test:3000', apiKey: 'k' }) })

    const after = await (await mainApp.request('/servers', { headers: { 'X-Api-Key': 'test-api-key' } })).json() as { peers: Array<{ name: string }> }
    expect(after.peers.some(p => p.name === 'Bob')).toBe(true)
  })
})

describe('Management API updatePeer url change', () => {
  test('rekeys the connector map and cascades download rows', async () => {
    const { app, connectorManager, downloadsRepository } = await makeMutableApp()
    const urlA = 'http://bob.test:3000'
    const urlB = 'http://bob2.test:3000'
    const idA = generateId(urlA)
    const idB = generateId(urlB)

    await app.request('/config/peers', { method: 'POST', headers: { ...KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Bob', url: urlA, apiKey: 'k' }) })

    const dl = downloadsRepository.create({
      torrentFilename: 'm.torrent',
      peerId: idA,
      peerName: 'Bob',
      itemId: 'movie:1',
      filename: 'm.mkv',
      destPath: '/tmp/m.mkv',
      partPath: '/tmp/m.mkv.part',
      releaseSize: 1,
      release: { id: 'r', title: 'm', filename: 'm.mkv', category: 2000, size: 1 } as any,
    })

    const res = await app.request(`/config/peers/${idA}`, {
      method: 'PATCH',
      headers: { ...KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Bob', url: urlB, apiKey: 'k' }),
    })
    expect(res.status).toBe(200)

    expect(connectorManager.peers.some(p => p.id === idB)).toBe(true)
    expect(connectorManager.peers.some(p => p.id === idA)).toBe(false)
    expect(downloadsRepository.get(dl.id)?.peerId).toBe(idB)
  })
})
