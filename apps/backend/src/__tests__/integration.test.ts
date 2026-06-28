import type { Envs } from '../lib/envs'
import type { Release } from '../lib/release'
import { Database } from 'bun:sqlite'
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { http, HttpResponse } from 'msw'
import { setupServer } from 'msw/node'
import { getApp } from '../app'
import { runMigrations } from '../database/connection'
import * as schema from '../database/schema'
import { AppConfig, MIGRATIONS } from '../lib/config'
import { RadarrServerConnector } from '../lib/servers/arr/radarr'
import { SonarrServerConnector } from '../lib/servers/arr/sonarr'
import { PeerConnector } from '../lib/servers/peer'
import { DownloadsRepository } from '../modules/downloads/downloads.repository'
import { ManagedKeysRepository } from '../modules/managed-keys/managed-keys.repository'
import { ManagedApiKeys } from '../modules/managed-keys/managed-keys.service'

const RADARR_URL = 'http://radarr.test:7878'
const SONARR_URL = 'http://sonarr.test:8989'
const PEER_JACK_URL = 'http://peer-jack.test:3000'
const HEX_KEY = 'a'.repeat(32)

// A movie that lives in the local Radarr library, with a file on disk.
const mockMovie = {
  id: 1,
  title: 'The Matrix',
  year: 1999,
  imdbId: 'tt0133093',
  tmdbId: 603,
  hasFile: true,
  sizeOnDisk: 2_000_000_000,
  movieFile: {
    id: 11,
    movieId: 1,
    relativePath: 'The Matrix (1999) Bluray-1080p.mkv',
    path: '/media/movies/The Matrix (1999)/The Matrix (1999) Bluray-1080p.mkv',
    size: 2_000_000_000,
    dateAdded: '2021-01-01T00:00:00Z',
    sceneName: 'The.Matrix.1999.1080p.BluRay.x264-GROUP',
    releaseGroup: 'GROUP',
    quality: { quality: { id: 7, name: 'Bluray-1080p', source: 'bluray', resolution: 1080 } },
    languages: [{ id: 1, name: 'English' }],
    mediaInfo: { videoCodec: 'x264', audioCodec: 'DTS' },
  },
}

// A release served by a peer jack (already normalized).
const peerRelease: Release = {
  id: 'remote1:movie:99',
  title: 'The.Matrix.1999.1080p.BluRay.x264-GRP',
  filename: 'The.Matrix.1999.1080p.BluRay.x264-GRP.mkv',
  category: 2000,
  size: 2_000_000_000,
  imdbId: 'tt0133093',
  tmdbId: 603,
  quality: { name: 'Bluray-1080p', source: 'bluray', resolution: 1080 },
}

const handlers = [
  // ---- Local Radarr (source + destination) ----
  http.get(`${RADARR_URL}/api/v3/system/status`, () => HttpResponse.json({ appName: 'Radarr', version: '4.0.0' })),
  http.get(`${RADARR_URL}/api/v3/movie`, ({ request }) => {
    const imdbId = new URL(request.url).searchParams.get('imdbId')
    const movies = imdbId && mockMovie.imdbId !== imdbId ? [] : [mockMovie]
    return HttpResponse.json(movies)
  }),
  http.get(`${RADARR_URL}/api/v3/movie/:id`, ({ params }) => {
    if (String(params.id) !== String(mockMovie.id))
      return HttpResponse.json({}, { status: 404 })
    return HttpResponse.json(mockMovie)
  }),
  http.get(`${RADARR_URL}/api/v3/indexer`, () => HttpResponse.json([])),
  http.post(`${RADARR_URL}/api/v3/indexer`, () => HttpResponse.json({ id: 1, name: 'Jack' })),
  http.get(`${RADARR_URL}/api/v3/downloadclient`, () => HttpResponse.json([])),
  http.post(`${RADARR_URL}/api/v3/downloadclient`, () => HttpResponse.json({ id: 1, name: 'Jack' })),
  http.post(`${RADARR_URL}/api/v3/command`, () => HttpResponse.json({ id: 1 })),
  http.get(`${RADARR_URL}/api/v3/health`, () => HttpResponse.json([])),

  // ---- Local Sonarr (destination) — for the tvCategory download-client test ----
  http.get(`${SONARR_URL}/api/v3/system/status`, () => HttpResponse.json({ appName: 'Sonarr', version: '4.0.0' })),
  http.get(`${SONARR_URL}/api/v3/downloadclient`, () => HttpResponse.json([])),
  http.post(`${SONARR_URL}/api/v3/downloadclient`, () => HttpResponse.json({ id: 1, name: 'Jack' })),

  // ---- Peer jack ----
  http.get(`${PEER_JACK_URL}/peer/search`, ({ request }) => {
    const url = new URL(request.url)
    const imdbId = url.searchParams.get('imdbId')
    const tmdbId = url.searchParams.get('tmdbId')
    let items = [peerRelease]
    // No params = catalog (return everything); ids filter.
    if (imdbId)
      items = items.filter(r => r.imdbId === imdbId)
    if (tmdbId)
      items = items.filter(r => String(r.tmdbId) === tmdbId)
    return HttpResponse.json({ items })
  }),
  http.get(`${PEER_JACK_URL}/peer/items/:itemId`, () => HttpResponse.json(peerRelease)),
]

const server = setupServer(...handlers)

const testDatabases: Database[] = []

beforeAll(() => server.listen({ onUnhandledRequest: 'bypass' }))
afterEach(() => {
  server.resetHandlers()
  for (const db of testDatabases.splice(0))
    db.close()
})
afterAll(() => server.close())

const config = AppConfig.parse({
  version: MIGRATIONS.length,
  jack: { internalUrl: 'http://localhost:3000', apiKey: 'test-api-key' },
  downloads: { completedPath: '/tmp/jack-test-completed' },
  servers: [],
  peers: [],
})

const envs: Envs = {
  APP_CONFIG_PATH: '/data/config.json',
  ENABLE_LOGS: false,
  ENVIRONMENT: 'test' as any,
  HTTP_TIMEOUT_MS: 3000,
  LOG_LEVEL: 'fatal',
  OTEL_SERVICE_NAME: 'jack-server',
  PORT: 3000,
  MANAGEMENT_PORT: 5226,
  NODE_ENV: 'test',
}

const AUTOREGISTER = { enable: true, priority: 1 }

function markInitialized<T extends object>(connector: T): T {
  const c = connector as any
  c._isInitialized = true
  c._initState = 'initialized'
  // The init guard awaits the `initialization` promise; resolve it so guarded
  // calls don't hang waiting on an init that the test skips.
  c._initialization.resolve()
  return connector
}

function makeRadarr(overrides?: { source?: boolean, destination?: boolean }) {
  return new RadarrServerConnector({
    url: RADARR_URL,
    apiKey: HEX_KEY,
    name: 'My Radarr',
    source: overrides?.source ?? true,
    destination: overrides?.destination ?? true,
    autoregister: AUTOREGISTER,
  })
}

function makeSonarr(overrides?: { source?: boolean, destination?: boolean }) {
  return new SonarrServerConnector({
    url: SONARR_URL,
    apiKey: HEX_KEY,
    name: 'My Sonarr',
    source: overrides?.source ?? true,
    destination: overrides?.destination ?? true,
    autoregister: AUTOREGISTER,
  })
}

function createTestApp() {
  const radarr = markInitialized(makeRadarr())
  const peer = markInitialized(new PeerConnector({ url: PEER_JACK_URL, apiKey: 'peer-api-key', name: 'Friend Jack' }))
  const database = new Database(':memory:')
  testDatabases.push(database)
  database.exec('pragma foreign_keys = ON')
  const db = drizzle({ client: database, schema })
  runMigrations(db)
  const downloadsRepository = new DownloadsRepository(db)
  return { app: getApp(envs, config, { servers: [radarr], peers: [peer] }, { downloadsRepository }), radarr, peer, database, downloadsRepository }
}

describe('Peer API', () => {
  test('GET /peer/search returns releases from the local Radarr', async () => {
    const { app } = createTestApp()
    const res = await app.request('/peer/search?q=Matrix&apikey=test-api-key')
    expect(res.status).toBe(200)
    const body = await res.json() as { items: Release[] }
    expect(body.items.length).toBeGreaterThan(0)
    expect(body.items[0]?.imdbId).toBe('tt0133093')
    expect(body.items[0]?.category).toBe(2000)
    expect(body.items[0]?.title).toContain('Matrix')
  })

  test('GET /peer/search rejects wrong apiKey', async () => {
    const { app } = createTestApp()
    const res = await app.request('/peer/search?q=Matrix&apikey=wrong-key')
    if (res.status !== 401) {
      console.error(await res.text())
    }
    expect(res.status).toBe(401)
  })

  test('GET /peer/items/:id returns the release for the owning source', async () => {
    const { app, radarr } = createTestApp()
    const id = `${radarr.id}:movie:1`
    const res = await app.request(`/peer/items/${encodeURIComponent(id)}`, {
      headers: { 'X-Api-Key': 'test-api-key' },
    })
    expect(res.status).toBe(200)
    const body = await res.json() as Release
    expect(body.imdbId).toBe('tt0133093')
    expect(body.filename).toContain('.mkv')
  })
})

describe('Torznab API', () => {
  test('GET /torznab/api?t=caps returns XML capabilities', async () => {
    const { app } = createTestApp()
    const res = await app.request('/torznab/api?t=caps&apikey=test-api-key')
    expect(res.status).toBe(200)
    const xml = await res.text()
    expect(xml).toContain('<caps>')
    expect(xml).toContain('category id="2000"')
    expect(xml).toContain('category id="5000"')
  })

  test('GET /torznab/api?t=search (no term) returns the catalog from peers', async () => {
    const { app } = createTestApp()
    const res = await app.request('/torznab/api?t=search&apikey=test-api-key')
    expect(res.status).toBe(200)
    const xml = await res.text()
    expect(xml).toContain('<rss version="2.0"')
    expect(xml).toContain(peerRelease.title)
    expect(xml).toContain('application/x-bittorrent')
    expect(xml).toContain('apikey=test-api-key')
  })

  test('GET /torznab/api?t=search with a term is NOT fanned out (empty)', async () => {
    const { app } = createTestApp()
    const res = await app.request('/torznab/api?t=search&q=Matrix&apikey=test-api-key')
    expect(res.status).toBe(200)
    const xml = await res.text()
    expect(xml).not.toContain(peerRelease.title)
  })

  test('GET /torznab/api?t=movie&imdbid=tt0133093 searches by IMDB', async () => {
    const { app } = createTestApp()
    const res = await app.request('/torznab/api?t=movie&imdbid=tt0133093&apikey=test-api-key')
    expect(res.status).toBe(200)
    const xml = await res.text()
    expect(xml).toContain(peerRelease.title)
    expect(xml).toContain('name="imdbid" value="tt0133093"')
  })

  test('GET /torznab/api?t=movie&tmdbid=603 searches by TMDB', async () => {
    const { app } = createTestApp()
    const res = await app.request('/torznab/api?t=movie&tmdbid=603&apikey=test-api-key')
    expect(res.status).toBe(200)
    const xml = await res.text()
    expect(xml).toContain(peerRelease.title)
  })

  test('an over-eager peer (returns its whole catalog) is filtered to the searched id', async () => {
    const { app } = createTestApp()
    const otherRelease: Release = { ...peerRelease, id: 'remote1:movie:2', title: 'Some.Other.Movie.2020.1080p', imdbId: 'tt9999999', tmdbId: 111 }
    // Simulate an old/over-eager peer that ignores the id and returns everything.
    server.use(
      http.get(`${PEER_JACK_URL}/peer/search`, () => HttpResponse.json({ items: [peerRelease, otherRelease] })),
    )
    const res = await app.request('/torznab/api?t=movie&tmdbid=603&apikey=test-api-key')
    const xml = await res.text()
    expect(xml).toContain(peerRelease.title)
    expect(xml).not.toContain('Some.Other.Movie')
  })

  test('cat filters the feed: cat=5000 drops movies, cat=2000 keeps them', async () => {
    const { app } = createTestApp()
    const tv = await (await app.request('/torznab/api?t=search&cat=5000&apikey=test-api-key')).text()
    expect(tv).not.toContain(peerRelease.title) // peerRelease is a movie (2000)
    const movies = await (await app.request('/torznab/api?t=search&cat=2000&apikey=test-api-key')).text()
    expect(movies).toContain(peerRelease.title)
  })

  test('Torznab rejects wrong apikey', async () => {
    const { app } = createTestApp()
    const res = await app.request('/torznab/api?t=caps&apikey=wrong')
    expect(res.status).toBe(401)
  })

  test('Torznab rejects unknown function', async () => {
    const { app } = createTestApp()
    const res = await app.request('/torznab/api?t=unknown&apikey=test-api-key')
    expect(res.status).toBe(400)
  })
})

describe('Torrent download', () => {
  test('GET /torznab/download/:id.torrent returns a torrent stub', async () => {
    const { app, peer } = createTestApp()
    const guid = `${peer.id}:${peerRelease.id}`

    const res = await app.request(`/torznab/download/${encodeURIComponent(guid)}.torrent?apikey=test-api-key`)
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('application/x-bittorrent')
  })

  test('GET /torznab/download/:id.torrent rejects missing apiKey', async () => {
    const { app, peer } = createTestApp()
    const guid = `${peer.id}:${peerRelease.id}`

    const res = await app.request(`/torznab/download/${encodeURIComponent(guid)}.torrent`)
    expect(res.status).toBe(401)
  })

  // Production scenario: the main key is unset and Radarr authenticates the indexer
  // with a managed key. The feed must embed THAT managed key in each download URL,
  // and grabbing the .torrent with it must succeed (regression for the 401-on-grab).
  test('feed embeds the requester managed key, and the grab round-trips', async () => {
    const database = new Database(':memory:')
    testDatabases.push(database)
    database.exec('pragma foreign_keys = ON')
    const db = drizzle({ client: database, schema })
    runMigrations(db)
    const downloadsRepository = new DownloadsRepository(db)
    const managedKeysRepository = new ManagedKeysRepository(db)

    const radarr = markInitialized(makeRadarr())
    const peer = markInitialized(new PeerConnector({ url: PEER_JACK_URL, apiKey: 'peer-api-key', name: 'Friend Jack' }))
    const { key: managedKey } = new ManagedApiKeys(managedKeysRepository).provision(radarr.id)

    const app = getApp(envs, config, { servers: [radarr], peers: [peer] }, { downloadsRepository, managedKeysRepository })

    const feed = await (await app.request(`/torznab/api?t=movie&tmdbid=603&apikey=${managedKey}`)).text()
    expect(feed).toContain(peerRelease.title)
    expect(feed).toContain(`apikey=${managedKey}`)
    expect(feed).not.toContain('apikey=test-api-key')

    const guid = `${peer.id}:${peerRelease.id}`
    const grab = await app.request(`/torznab/download/${encodeURIComponent(guid)}.torrent?apikey=${managedKey}`)
    expect(grab.status).toBe(200)
  })
})

describe('Downloads API', () => {
  test('GET /downloads returns persisted download state', async () => {
    const { app, downloadsRepository } = createTestApp()
    downloadsRepository.create({
      torrentFilename: 'movie.torrent',
      peerId: 'peer-1',
      peerName: 'Friend Jack',
      itemId: 'movie:1',
      filename: peerRelease.filename,
      destPath: '/tmp/completed/Movie.mkv',
      partPath: '/tmp/completed/Movie.mkv.part',
      releaseSize: peerRelease.size,
      release: peerRelease,
    })

    const res = await app.request('/downloads', { headers: { 'X-Api-Key': 'test-api-key' } })
    expect(res.status).toBe(200)
    const body = await res.json() as { downloads: Array<{ torrentFilename: string }> }
    expect(body.downloads[0]?.torrentFilename).toBe('movie.torrent')
  })
})

describe('Auto-registration', () => {
  test('registerIndexer calls the Radarr API', async () => {
    const radarr = markInitialized(makeRadarr())
    await radarr.registerIndexer({
      name: 'Jack',
      internalUrl: 'http://localhost:3000/torznab',
      apiKey: 'test-api-key',
      priority: 1,
      categories: [2000],
    })
    // If it doesn't throw, the API call worked
  })

  test('registerIndexer binds the indexer to the given download client id', async () => {
    let createdBody: any = null
    server.use(
      http.post(`${RADARR_URL}/api/v3/indexer`, async ({ request }) => {
        createdBody = await request.json()
        return HttpResponse.json({ id: 1, name: 'Jack' })
      }),
    )

    const radarr = markInitialized(makeRadarr())
    await radarr.registerIndexer({
      name: 'Jack',
      internalUrl: 'http://localhost:3000/torznab',
      apiKey: 'test-api-key',
      priority: 1,
      categories: [2000],
      downloadClientId: 42,
    })

    expect(createdBody.downloadClientId).toBe(42)
  })

  test('registerIndexer omits downloadClientId when none is provided', async () => {
    let createdBody: any = null
    server.use(
      http.post(`${RADARR_URL}/api/v3/indexer`, async ({ request }) => {
        createdBody = await request.json()
        return HttpResponse.json({ id: 1, name: 'Jack' })
      }),
    )

    const radarr = markInitialized(makeRadarr())
    await radarr.registerIndexer({
      name: 'Jack',
      internalUrl: 'http://localhost:3000/torznab',
      apiKey: 'test-api-key',
      priority: 1,
      categories: [2000],
    })

    expect(createdBody.downloadClientId).toBeUndefined()
  })

  test('registerIndexer throws when a source-only server is used as a destination', async () => {
    const radarr = markInitialized(makeRadarr({ source: true, destination: false }))
    await expect(radarr.registerIndexer({
      name: 'Jack',
      internalUrl: 'http://localhost:3000/torznab',
      apiKey: 'test-api-key',
      priority: 1,
      categories: [2000],
    })).rejects.toThrow()
  })

  test('registerIndexer fails (does not register) when Radarr rejects with 400', async () => {
    server.use(
      http.post(`${RADARR_URL}/api/v3/indexer`, () => {
        return HttpResponse.json({ message: 'Unable to connect to indexer' }, { status: 400 })
      }),
    )

    const radarr = markInitialized(makeRadarr())
    await expect(radarr.registerIndexer({
      name: 'Jack',
      internalUrl: 'http://localhost:3000/torznab',
      apiKey: 'test-api-key',
      priority: 1,
      categories: [2000],
    })).rejects.toThrow()
  })

  test('registerDownloadClient registers a qBittorrent client (Radarr → movieCategory)', async () => {
    let createdBody: any = null
    server.use(
      http.post(`${RADARR_URL}/api/v3/downloadclient`, async ({ request }) => {
        createdBody = await request.json()
        return HttpResponse.json({ id: 7, name: 'Jack' })
      }),
    )

    const radarr = markInitialized(makeRadarr())
    const id = await radarr.registerDownloadClient({
      name: 'Jack',
      internalUrl: 'http://jack:5225',
      username: 'My Radarr',
      password: 'secret',
      category: 'jack-abc',
    })

    expect(id).toBe(7)
    expect(createdBody).toMatchObject({
      name: 'Jack',
      enable: true,
      protocol: 'torrent',
      implementation: 'QBittorrent',
      configContract: 'QBittorrentSettings',
      priority: 50, // lowest priority so the general client pool never picks Jack
      tags: [],
    })
    expect(createdBody.fields).toContainEqual({ name: 'host', value: 'jack' })
    expect(createdBody.fields).toContainEqual({ name: 'port', value: 5225 })
    expect(createdBody.fields).toContainEqual({ name: 'useSsl', value: false })
    expect(createdBody.fields).toContainEqual({ name: 'username', value: 'My Radarr' })
    expect(createdBody.fields).toContainEqual({ name: 'password', value: 'secret' })
    expect(createdBody.fields).toContainEqual({ name: 'movieCategory', value: 'jack-abc' })
  })

  test('registerDownloadClient uses tvCategory for Sonarr', async () => {
    let createdBody: any = null
    server.use(
      http.post(`${SONARR_URL}/api/v3/downloadclient`, async ({ request }) => {
        createdBody = await request.json()
        return HttpResponse.json({ id: 9, name: 'Jack' })
      }),
    )

    const sonarr = markInitialized(makeSonarr())
    const id = await sonarr.registerDownloadClient({
      name: 'Jack',
      internalUrl: 'http://jack:5225',
      username: 'My Sonarr',
      password: 'secret',
      category: 'jack-def',
    })

    expect(id).toBe(9)
    expect(createdBody.fields).toContainEqual({ name: 'tvCategory', value: 'jack-def' })
    expect(createdBody.fields).not.toContainEqual({ name: 'movieCategory', value: 'jack-def' })
  })

  test('registerDownloadClient upgrades an existing blackhole "Jack" client in place (PUT, no duplicate)', async () => {
    let putBody: any = null
    server.use(
      http.get(`${RADARR_URL}/api/v3/downloadclient`, () => {
        return HttpResponse.json([
          { id: 3, name: 'Jack', implementation: 'TorrentBlackhole', fields: [] },
        ])
      }),
      http.put(`${RADARR_URL}/api/v3/downloadclient/3`, async ({ request }) => {
        putBody = await request.json()
        return HttpResponse.json({ id: 3, name: 'Jack' })
      }),
    )

    const radarr = markInitialized(makeRadarr())
    const id = await radarr.registerDownloadClient({
      name: 'Jack',
      internalUrl: 'http://jack:5225',
      username: 'My Radarr',
      password: 'secret',
      category: 'jack-abc',
    })

    expect(id).toBe(3)
    expect(putBody.implementation).toBe('QBittorrent')
    expect(putBody.id).toBe(3)
  })

  test('registerDownloadClient registers at lowest priority and clears tags (so the general pool never picks Jack)', async () => {
    let putBody: any = null
    server.use(
      // A prior version had tagged this client; the upgrade PUT must clear it.
      http.get(`${RADARR_URL}/api/v3/downloadclient`, () =>
        HttpResponse.json([{ id: 5, name: 'Jack', implementation: 'QBittorrent', priority: 1, tags: [1] }])),
      http.put(`${RADARR_URL}/api/v3/downloadclient/5`, async ({ request }) => {
        putBody = await request.json()
        return HttpResponse.json({ id: 5, name: 'Jack' })
      }),
    )

    const radarr = markInitialized(makeRadarr())
    const id = await radarr.registerDownloadClient({
      name: 'Jack',
      internalUrl: 'http://jack:5225',
      username: 'My Radarr',
      password: 'secret',
      category: 'jack-abc',
    })

    expect(id).toBe(5)
    expect(putBody.priority).toBe(50)
    expect(putBody.tags).toEqual([])
  })
})

describe('Routes mount without peers or sources', () => {
  function createBareApp() {
    return getApp(envs, config, { servers: [], peers: [] })
  }

  test('Torznab caps works with no peers', async () => {
    const res = await createBareApp().request('/torznab/api?t=caps&apikey=test-api-key')
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('<caps>')
  })

  test('Torznab search returns an empty feed with no peers', async () => {
    const res = await createBareApp().request('/torznab/api?t=search&q=anything&apikey=test-api-key')
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('<rss version="2.0"')
  })

  test('Peer search returns empty items with no source', async () => {
    const res = await createBareApp().request('/peer/search?q=anything&apikey=test-api-key')
    expect(res.status).toBe(200)
    const body = await res.json() as { items: Release[] }
    expect(body.items).toEqual([])
  })
})
