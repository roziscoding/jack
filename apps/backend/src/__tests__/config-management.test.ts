import type { Envs } from '../lib/envs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { jsonc } from 'jsonc'
import { http, HttpResponse } from 'msw'
import { setupServer } from 'msw/node'
import { getApp } from '../app'
import { AppConfig, MIGRATIONS } from '../lib/config'
import { ConnectorManager } from '../lib/servers'
import { PeerConnector } from '../lib/servers/peer'
import { PROTOCOL_VERSION } from '../lib/version'
import { getManagementApp } from '../management-app'
import { ConfigService } from '../modules/config/config.service'

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
  http.get('http://carol.test:3000/handshake', () => HttpResponse.json({ name: 'jack', version: PROTOCOL_VERSION })),
)
beforeAll(() => mswServer.listen({ onUnhandledRequest: 'bypass' }))
afterAll(() => mswServer.close())

const tempFiles: string[] = []
afterEach(async () => {
  for (const f of tempFiles.splice(0))
    await rm(f, { force: true })
})

// `app` is the MANAGEMENT app (where /config lives); `mainApp` is the public peer
// app (where /torznab etc. live). Both share the same in-process connectorManager +
// configService, so a mutation on `app` is visible to `mainApp` (see Phase 7).
async function makeMutableApp(managementKey = 'mgmt-secret') {
  const path = join(tmpdir(), `jack-config-${Math.random().toString(36).slice(2)}.jsonc`)
  tempFiles.push(path)
  await Bun.write(path, jsonc.stringify({ version: 1, peers: [], servers: [] }, { space: 2 }))
  const connectorManager = new ConnectorManager([], [])
  const configService = await ConfigService.fromFile({ path, connectorManager })
  const app = getManagementApp({ environment: 'test', managementKey, connectors: connectorManager, configService })
  const mainApp = getApp(makeEnvs(managementKey), config, connectorManager)
  return { app, mainApp, path, connectorManager }
}

const KEY = { 'X-Management-Key': 'mgmt-secret' } as const

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
