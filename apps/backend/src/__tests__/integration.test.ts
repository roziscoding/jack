import { describe, test, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { http, HttpResponse } from 'msw'
import { setupServer } from 'msw/node'
import { getApp } from '../app'
import type { AppConfig } from '../lib/config'
import { JellyfinServerConnector } from '../lib/servers/sources/jellyfin'
import { JackServerConnector } from '../lib/servers/sources/jack'
import { RadarrServerConnector } from '../lib/servers/destinations/radarr'

const JELLYFIN_URL = 'http://jellyfin.test:8096'
const PEER_JACK_URL = 'http://peer-jack.test:3000'
const RADARR_URL = 'http://radarr.test:7878'

const mockJellyfinItems = [
  {
    Id: 'movie-1',
    Name: 'The Matrix',
    Type: 'Movie',
    ProviderIds: { Imdb: 'tt0133093', Tvdb: null },
    MediaSources: [{ Size: 2000000000, Path: '/media/movies/The Matrix (1999)/The Matrix.mkv' }],
    Path: '/media/movies/The Matrix (1999)/The Matrix.mkv',
  },
  {
    Id: 'episode-1',
    Name: 'Pilot',
    Type: 'Episode',
    ProviderIds: { Tvdb: '73255', Imdb: null },
    MediaSources: [{ Size: 500000000, Path: '/media/tv/Breaking Bad/S01E01.mkv' }],
    Path: '/media/tv/Breaking Bad/S01E01.mkv',
    ParentIndexNumber: 1,
    IndexNumber: 1,
  },
]

const handlers = [
  // Jellyfin System Info
  http.get(`${JELLYFIN_URL}/System/Info`, () => {
    return HttpResponse.json({ ProductName: 'Jellyfin Server', Version: '10.8.0' })
  }),

  // Jellyfin Items search
  http.get(`${JELLYFIN_URL}/Items`, ({ request }) => {
    const url = new URL(request.url)
    const searchTerm = url.searchParams.get('searchTerm') ?? ''
    const hasImdbId = url.searchParams.get('hasImdbId')

    let items = mockJellyfinItems
    if (searchTerm) {
      items = items.filter(i => i.Name.toLowerCase().includes(searchTerm.toLowerCase()))
    }

    return HttpResponse.json({ Items: items, TotalRecordCount: items.length })
  }),

  // Jellyfin single item
  http.get(`${JELLYFIN_URL}/Items/:itemId`, ({ params }) => {
    const item = mockJellyfinItems.find(i => i.Id === params.itemId)
    if (!item) return HttpResponse.json({}, { status: 404 })
    return HttpResponse.json(item)
  }),

  // Peer Jack search
  http.get(`${PEER_JACK_URL}/peer/search`, ({ request }) => {
    const url = new URL(request.url)
    const q = url.searchParams.get('q') ?? ''
    const imdbId = url.searchParams.get('imdbId')

    let items = mockJellyfinItems
    if (q) items = items.filter(i => i.Name.toLowerCase().includes(q.toLowerCase()))
    if (imdbId) items = items.filter(i => i.ProviderIds?.Imdb === imdbId)

    return HttpResponse.json({ items })
  }),

  // Peer Jack item metadata
  http.get(`${PEER_JACK_URL}/peer/items/:itemId`, ({ params }) => {
    const item = mockJellyfinItems.find(i => i.Id === params.itemId)
    if (!item) return HttpResponse.json({ error: 'Not found' }, { status: 404 })
    return HttpResponse.json(item)
  }),

  // Radarr system status
  http.get(`${RADARR_URL}/api/v3/system/status`, () => {
    return HttpResponse.json({ appName: 'Radarr', version: '4.0.0' })
  }),

  // Radarr indexer list
  http.get(`${RADARR_URL}/api/v3/indexer`, () => {
    return HttpResponse.json([])
  }),

  // Radarr indexer create
  http.post(`${RADARR_URL}/api/v3/indexer`, () => {
    return HttpResponse.json({ id: 1, name: 'Jack' })
  }),

  // Radarr command
  http.post(`${RADARR_URL}/api/v3/command`, () => {
    return HttpResponse.json({ id: 1 })
  }),

  // Radarr health
  http.get(`${RADARR_URL}/api/v3/health`, () => {
    return HttpResponse.json([])
  }),
]

const server = setupServer(...handlers)

beforeAll(() => server.listen({ onUnhandledRequest: 'bypass' }))
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

const config: AppConfig = {
  jack: {
    baseUrl: 'http://localhost:3000',
    apiKey: 'test-api-key',
    mediaPath: '/media',
  },
  indexer: { priority: 1, autoRegister: true },
  downloads: { watchPath: '/tmp/jack-test-watch', completedPath: '/tmp/jack-test-completed' },
  servers: {
    sources: [{ type: 'jellyfin', url: JELLYFIN_URL, apiKey: 'jf-api-key', name: 'Local Jellyfin' }],
    peers: [{ url: PEER_JACK_URL, apiKey: 'peer-api-key', name: 'Friend Jack' }],
    destinations: [{ type: 'radarr', url: RADARR_URL, apiKey: 'a'.repeat(32), name: 'My Radarr' }],
  },
}

function createTestApp() {
  const jellyfin = new JellyfinServerConnector({ url: JELLYFIN_URL, apiKey: 'jf-api-key', name: 'Local Jellyfin' })
  const peer = new JackServerConnector({ url: PEER_JACK_URL, apiKey: 'peer-api-key', name: 'Friend Jack' })
  const radarr = new RadarrServerConnector({ url: RADARR_URL, apiKey: 'a'.repeat(32), name: 'My Radarr' })

  // Mark as initialized for testing
  jellyfin._isInitialized = true
  peer._isInitialized = true
  radarr._isInitialized = true

  const connectors = {
    sources: [jellyfin],
    peers: [peer],
    destinations: [radarr],
  }

  return getApp(config, connectors)
}

describe('Peer API', () => {
  test('GET /peer/search returns items from Jellyfin', async () => {
    const app = createTestApp()
    const res = await app.request('/peer/search?q=Matrix&apikey=test-api-key')
    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.items).toBeArray()
    expect(body.items.length).toBeGreaterThan(0)
    expect(body.items[0].Name).toBe('The Matrix')
  })

  test('GET /peer/search rejects wrong apiKey', async () => {
    const app = createTestApp()
    const res = await app.request('/peer/search?q=Matrix&apikey=wrong-key')
    expect(res.status).toBe(401)
  })

  test('GET /peer/items/:id returns item metadata', async () => {
    const app = createTestApp()
    const res = await app.request('/peer/items/movie-1?apikey=test-api-key', {
      headers: { 'X-Api-Key': 'test-api-key' },
    })
    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.Name).toBe('The Matrix')
  })
})

describe('Torznab API', () => {
  test('GET /torznab/api?t=caps returns XML capabilities', async () => {
    const app = createTestApp()
    const res = await app.request('/torznab/api?t=caps&apikey=test-api-key')
    expect(res.status).toBe(200)
    const xml = await res.text()
    expect(xml).toContain('<caps>')
    expect(xml).toContain('category id="2000"')
    expect(xml).toContain('category id="5000"')
  })

  test('GET /torznab/api?t=search returns RSS results', async () => {
    const app = createTestApp()
    const res = await app.request('/torznab/api?t=search&q=Matrix&apikey=test-api-key')
    expect(res.status).toBe(200)
    const xml = await res.text()
    expect(xml).toContain('<rss version="2.0"')
    expect(xml).toContain('The Matrix')
    expect(xml).toContain('application/x-bittorrent')
  })

  test('GET /torznab/api?t=movie&imdbid=tt0133093 searches by IMDB', async () => {
    const app = createTestApp()
    const res = await app.request('/torznab/api?t=movie&imdbid=tt0133093&apikey=test-api-key')
    expect(res.status).toBe(200)
    const xml = await res.text()
    expect(xml).toContain('The Matrix')
  })

  test('Torznab rejects wrong apikey', async () => {
    const app = createTestApp()
    const res = await app.request('/torznab/api?t=caps&apikey=wrong')
    expect(res.status).toBe(403)
    const xml = await res.text()
    expect(xml).toContain('Incorrect API Key')
  })

  test('Torznab rejects unknown function', async () => {
    const app = createTestApp()
    const res = await app.request('/torznab/api?t=unknown&apikey=test-api-key')
    expect(res.status).toBe(400)
    const xml = await res.text()
    expect(xml).toContain('Unknown function')
  })
})

describe('Torrent download', () => {
  test('GET /torznab/download/:id.torrent returns torrent file', async () => {
    const app = createTestApp()
    const peer = new JackServerConnector({ url: PEER_JACK_URL, apiKey: 'peer-api-key', name: 'Friend Jack' })
    const peerId = peer.id

    const res = await app.request(`/torznab/download/${peerId}:movie-1.torrent?apikey=test-api-key`)
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('application/x-bittorrent')
  })
})

describe('Auto-registration', () => {
  test('registerIndexer calls Radarr API', async () => {
    const radarr = new RadarrServerConnector({ url: RADARR_URL, apiKey: 'a'.repeat(32), name: 'My Radarr' })
    radarr._isInitialized = true

    await radarr.registerIndexer({
      name: 'Jack',
      baseUrl: 'http://localhost:3000/torznab',
      apiKey: 'test-api-key',
      priority: 1,
      categories: [2000],
    })
    // If it doesn't throw, the API call worked
  })
})
