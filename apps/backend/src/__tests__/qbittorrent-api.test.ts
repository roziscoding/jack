import { Database } from 'bun:sqlite'
import { beforeEach, describe, expect, test } from 'bun:test'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { getApp } from '../app'
import { runMigrations } from '../database/connection'
import * as schema from '../database/schema'
import { AppConfig } from '../lib/config'
import { DownloadsRepository } from '../modules/downloads/downloads.repository'

const envs = { ENVIRONMENT: 'test', ENABLE_LOGS: false, LOG_LEVEL: 'fatal' } as any

const fakeServer = { id: 'abc12345', name: 'My Radarr', type: 'radarr', categories: [2000] } as any

function buildApp() {
  const sqlite = new Database(':memory:')
  const db = drizzle({ client: sqlite, schema })
  runMigrations(db)
  const repository = new DownloadsRepository(db)
  const config = AppConfig.parse({
    jack: { baseUrl: 'http://jack:5225', apiKey: 'test-api-key' },
    downloads: { watchPath: '/tmp/watch', completedPath: '/tmp/completed' },
    servers: [],
    peers: [],
  })
  const app = getApp(envs, config, { servers: [fakeServer], peers: [] }, { downloadsRepository: repository })
  return { app }
}

async function loginCookie(app: ReturnType<typeof buildApp>['app']): Promise<string> {
  const res = await app.request('/api/v2/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username: 'My Radarr', password: 'test-api-key' }),
  })
  const setCookie = res.headers.get('set-cookie') ?? ''
  return setCookie.split(';')[0] ?? '' // "SID=..."
}

describe('qBittorrent auth + app surface', () => {
  let app: ReturnType<typeof buildApp>['app']
  beforeEach(() => {
    app = buildApp().app
  })

  test('login succeeds for a known server name + correct password', async () => {
    const res = await app.request('/api/v2/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ username: 'My Radarr', password: 'test-api-key' }),
    })
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('Ok.')
    expect(res.headers.get('set-cookie') ?? '').toContain('SID=')
  })

  test('login fails for unknown username', async () => {
    const res = await app.request('/api/v2/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ username: 'Nope', password: 'test-api-key' }),
    })
    expect(await res.text()).toBe('Fails.')
  })

  test('protected endpoint returns 403 without session', async () => {
    const res = await app.request('/api/v2/app/webapiVersion')
    expect(res.status).toBe(403)
  })

  test('app endpoints return contract values with a session', async () => {
    const cookie = await loginCookie(app)
    const version = await app.request('/api/v2/app/webapiVersion', { headers: { cookie } })
    expect(await version.text()).toBe('2.9.2')

    const prefs = await app.request('/api/v2/app/preferences', { headers: { cookie } })
    const body = await prefs.json() as any
    expect(body.save_path).toBe('/tmp/completed')
    expect(body.max_ratio_enabled).toBe(false)
  })

  test('categories include jack-<serverId>', async () => {
    const cookie = await loginCookie(app)
    const res = await app.request('/api/v2/torrents/categories', { headers: { cookie } })
    const body = await res.json() as Record<string, unknown>
    expect(Object.keys(body)).toContain('jack-abc12345')
  })
})
