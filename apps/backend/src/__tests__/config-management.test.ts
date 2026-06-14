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
})

const mswServer = setupServer(
  http.get('http://bob.test:3000/handshake', () => HttpResponse.json({ name: 'jack', version: PROTOCOL_VERSION })),
  http.get('http://bob2.test:3000/handshake', () => HttpResponse.json({ name: 'jack', version: PROTOCOL_VERSION })),
  http.get('http://carol.test:3000/handshake', () => HttpResponse.json({ name: 'jack', version: PROTOCOL_VERSION })),
  http.get('http://radarr-new.test:7878/api/v3/system/status', () => HttpResponse.json({ appName: 'Radarr', version: '4.0.0' })),
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
