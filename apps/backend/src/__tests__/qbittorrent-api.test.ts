import { Database } from 'bun:sqlite'
import { beforeEach, describe, expect, test } from 'bun:test'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { getApp } from '../app'
import { runMigrations } from '../database/connection'
import * as schema from '../database/schema'
import { AppConfig } from '../lib/config'
import { DownloadsRepository } from '../modules/downloads/downloads.repository'
import { deriveHash, qbCategoryForServer } from '../modules/qbittorrent/qbittorrent.mapper'
import { createTorrentStub } from '../modules/torznab/torrent'

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
  return { app, repository }
}

function buildAppWithService() {
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
  const calls: any[] = []
  const downloadsService = {
    startQbDownload: async (input: any) => {
      calls.push(input)
      return null
    },
  } as any
  const app = getApp(envs, config, { servers: [fakeServer], peers: [] }, { downloadsRepository: repository, downloadsService })
  return { app, repository, calls }
}

function seedDownload(repository: DownloadsRepository, category: string) {
  return repository.create({
    torrentFilename: 'movie.torrent',
    peerId: 'peer0001',
    peerName: 'Peer',
    itemId: 'conn:movie:42',
    filename: 'Big Buck Bunny (2008).mkv',
    destPath: '/tmp/completed/Big Buck Bunny (2008).mkv',
    partPath: '/tmp/completed/Big Buck Bunny (2008).mkv.part',
    releaseSize: 10,
    release: { id: 'conn:movie:42', title: 'Big Buck Bunny', filename: 'Big Buck Bunny (2008).mkv', category: 2000, size: 10 } as any,
    qbCategory: category,
    qbSourceServer: 'My Radarr',
  })
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

describe('qBittorrent torrent mapping', () => {
  let app: ReturnType<typeof buildApp>['app']
  let repository: ReturnType<typeof buildApp>['repository']
  beforeEach(() => {
    const built = buildApp()
    app = built.app
    repository = built.repository
  })

  test('info, properties, and files reflect a seeded import_queued download', async () => {
    const category = qbCategoryForServer('abc12345')
    const created = seedDownload(repository, category)
    repository.markImportQueued(created.id)
    const hash = deriveHash('Big Buck Bunny', 10)
    const cookie = await loginCookie(app)

    const infoRes = await app.request(`/api/v2/torrents/info?category=${encodeURIComponent(category)}`, { headers: { cookie } })
    const info = await infoRes.json() as any[]
    expect(info).toHaveLength(1)
    expect(info[0].hash).toBe(hash)
    expect(info[0].state).toBe('pausedUP')
    expect(info[0].progress).toBe(1)

    const propsRes = await app.request(`/api/v2/torrents/properties?hash=${hash}`, { headers: { cookie } })
    expect(propsRes.status).toBe(200)
    const props = await propsRes.json() as { save_path: string }
    expect(props.save_path).toBe('/tmp/completed')

    const missingRes = await app.request('/api/v2/torrents/properties?hash=deadbeef', { headers: { cookie } })
    expect(missingRes.status).toBe(404)

    const filesRes = await app.request(`/api/v2/torrents/files?hash=${hash}`, { headers: { cookie } })
    const files = await filesRes.json() as { name: string }[]
    expect(files[0]?.name).toBe('Big Buck Bunny (2008).mkv')
  })
})

describe('qBittorrent add/delete/setCategory', () => {
  test('add with a valid jack stub file starts a qB download with the session category', async () => {
    const { app, calls } = buildAppWithService()
    const cookie = await loginCookie(app)
    const stub = createTorrentStub({ name: 'Big Buck Bunny', size: 10, peerId: 'peer0001', itemId: 'conn:movie:42' })
    const form = new FormData()
    form.append('torrents', new File([stub], 'x.torrent'))

    const res = await app.request('/api/v2/torrents/add', { method: 'POST', headers: { cookie }, body: form })

    expect(res.status).toBe(200)
    expect(await res.text()).toBe('Ok.')
    expect(calls).toHaveLength(1)
    expect(calls[0].peerId).toBe('peer0001')
    expect(calls[0].itemId).toBe('conn:movie:42')
    expect(calls[0].qbCategory).toBe('jack-abc12345')
    expect(calls[0].qbSourceServer).toBe('My Radarr')
  })

  test('add with a magnet url returns 415 and starts nothing', async () => {
    const { app, calls } = buildAppWithService()
    const cookie = await loginCookie(app)
    const form = new FormData()
    form.append('urls', 'magnet:?xt=urn:btih:deadbeef')

    const res = await app.request('/api/v2/torrents/add', { method: 'POST', headers: { cookie }, body: form })

    expect(res.status).toBe(415)
    expect(calls).toHaveLength(0)
  })

  test('add with non-jack torrent bytes returns 415', async () => {
    const { app, calls } = buildAppWithService()
    const cookie = await loginCookie(app)
    const form = new FormData()
    form.append('torrents', new File([new Uint8Array([1, 2, 3])], 'x.torrent'))

    const res = await app.request('/api/v2/torrents/add', { method: 'POST', headers: { cookie }, body: form })

    expect(res.status).toBe(415)
    expect(calls).toHaveLength(0)
  })

  test('delete removes a session-owned row by hash', async () => {
    const { app, repository } = buildAppWithService()
    const category = qbCategoryForServer('abc12345')
    const created = seedDownload(repository, category)
    const hash = deriveHash('Big Buck Bunny', 10)
    const cookie = await loginCookie(app)

    const res = await app.request('/api/v2/torrents/delete', {
      method: 'POST',
      headers: { 'cookie': cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ hashes: hash }),
    })

    expect(res.status).toBe(200)
    expect(repository.get(created.id)).toBeNull()
  })

  test('setCategory updates a session-owned row', async () => {
    const { app, repository } = buildAppWithService()
    const created = seedDownload(repository, qbCategoryForServer('abc12345'))
    const hash = deriveHash('Big Buck Bunny', 10)
    const cookie = await loginCookie(app)

    const res = await app.request('/api/v2/torrents/setCategory', {
      method: 'POST',
      headers: { 'cookie': cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ hashes: hash, category: 'renamed' }),
    })

    expect(res.status).toBe(200)
    expect(repository.get(created.id)?.qbCategory).toBe('renamed')
  })
})
