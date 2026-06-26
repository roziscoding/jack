import { describe, expect, test } from 'bun:test'
import { getApp } from '../app'
import { AppConfig, MIGRATIONS } from '../lib/config'
import { PROTOCOL_VERSION } from '../lib/version'

const envs = { ENVIRONMENT: 'test', ENABLE_LOGS: false, LOG_LEVEL: 'fatal' } as any

function buildApp() {
  const config = AppConfig.parse({
    version: MIGRATIONS.length,
    jack: { internalUrl: 'http://jack:5225', apiKey: 'test-api-key' },
    servers: [],
    peers: [],
  })
  return getApp(envs, config, { servers: [], peers: [] })
}

describe('GET /handshake', () => {
  test('returns the server identity and version with a valid api key', async () => {
    const res = await buildApp().request('/handshake?apikey=test-api-key')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ name: 'jack', version: PROTOCOL_VERSION })
  })

  test('rejects a request without an api key', async () => {
    const res = await buildApp().request('/handshake')
    expect(res.status).toBe(401)
  })
})
