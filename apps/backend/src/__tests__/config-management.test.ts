import type { Envs } from '../lib/envs'
import { describe, expect, test } from 'bun:test'
import { getApp } from '../app'
import { AppConfig, MIGRATIONS } from '../lib/config'
import { PeerConnector } from '../lib/servers/peer'
import { getManagementApp } from '../management-app'

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
