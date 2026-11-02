import type { PeerCatalogResponse, PeerCatalogTitle } from '../lib/peer-catalog'
import type { Release } from '../lib/release'
import type { OwnCatalogEntry } from '../modules/catalog/own-catalog.repository'
import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from 'bun:test'
import { http, HttpResponse } from 'msw'
import { setupServer } from 'msw/node'
import { openMemoryDatabase } from '../database/connection'
import { RadarrServerConnector } from '../lib/servers/arr/radarr'
import { PeerConnector } from '../lib/servers/peer'
import { indexEntries } from '../modules/catalog/catalog-sync.service'
import { OwnCatalogRepository } from '../modules/catalog/own-catalog.repository'
import { PeerController } from '../modules/peer/peer.controller'
import { getPeerRouter } from '../modules/peer/peer.router'

const server = setupServer()
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

async function connectedPeer(version: string) {
  server.use(http.get('http://peer.test/handshake', () => HttpResponse.json({ name: 'jack', version })))
  const peer = new PeerConnector({ url: 'http://peer.test', apiKey: 'peer-key', name: 'Friend Jack' })
  peer.init()
  await peer.initialization
  return peer
}

const release: Release = {
  id: 'src:movie:1',
  title: 'The.Matrix.1999.2160p',
  filename: 'The.Matrix.1999.2160p.mkv',
  category: 2000,
  size: 100,
  tmdbId: 603,
  quality: { resolution: 2160 },
}

describe('PeerConnector.listCatalog', () => {
  test('falls back to the full release list on a peer older than 0.2.0', async () => {
    const peer = await connectedPeer('0.1.0')
    server.use(http.get('http://peer.test/peer/search', () => HttpResponse.json({
      items: [release],
    })))

    expect(await peer.listCatalog()).toEqual({
      kind: 'releases',
      releases: [release],
    })
  })

  test('asks a 0.2.0+ peer for the changes since a revision of a generation', async () => {
    const peer = await connectedPeer('0.2.0')
    const title: PeerCatalogTitle = {
      mediaType: 'movie',
      tmdbId: 603,
      title: 'The Matrix',
      releaseCount: 1,
      totalSize: 100,
      resolutions: [2160],
    }
    const seen: string[] = []
    server.use(http.get('http://peer.test/peer/catalog', ({ request }) => {
      seen.push(new URL(request.url).search)
      return HttpResponse.json({
        revision: 7,
        generation: 'g1',
        full: false,
        titles: [title],
        removed: ['movie:id:604'],
      })
    }))

    expect(await peer.listCatalog({ revision: 5, generation: 'g1' })).toEqual({
      kind: 'titles',
      revision: 7,
      generation: 'g1',
      full: false,
      titles: [title],
      removed: ['movie:id:604'],
    })
    await peer.listCatalog()
    expect(seen).toEqual(['?since=5&generation=g1', ''])
  })
})

// The own catalog as a sync leaves it: `sources` maps a source id to its titles,
// then the catalog is merged from the given enabled sources.
function publish(own: OwnCatalogRepository, sources: Record<string, OwnCatalogEntry[]>, enabled = Object.keys(sources)) {
  for (const [sourceId, entries] of Object.entries(sources))
    own.replaceSource(sourceId, indexEntries(entries))
  own.dropSourcesExcept(enabled)
  own.merge(enabled)
}

const entry = (title: PeerCatalogTitle, releases: Release[] = []): OwnCatalogEntry => ({ title, releases })

describe('GET /peer/catalog', () => {
  const matrix: PeerCatalogTitle = {
    mediaType: 'movie',
    tmdbId: 603,
    title: 'The Matrix',
    releaseCount: 1,
    totalSize: 100,
    resolutions: [1080],
  }
  const reloaded: PeerCatalogTitle = { ...matrix, tmdbId: 604, title: 'The Matrix Reloaded' }

  function serve(sourceIds = ['radarr']) {
    const db = openMemoryDatabase()
    const own = new OwnCatalogRepository(db)
    const sources = sourceIds.map(id => ({ id, canSource: true }))
    const app = getPeerRouter(new PeerController(() => sources as any, own))
    const get = async (query = '') => (await app.request(`/catalog${query}`)).json() as Promise<PeerCatalogResponse>
    return { own, get, db, sources }
  }

  test('serves the whole catalog without `since`', async () => {
    const { own, get } = serve()
    publish(own, {
      radarr: [
        entry(matrix),
        entry(reloaded),
      ],
    })

    expect(await get()).toEqual({
      revision: 1,
      generation: own.generation(),
      full: true,
      titles: [matrix, reloaded],
      removed: [],
    })
  })

  test('serves only what changed after `since`, removals included', async () => {
    const { own, get } = serve()
    publish(own, {
      radarr: [
        entry(matrix),
        entry(reloaded),
      ],
    })
    publish(own, {
      radarr: [
        entry({
          ...matrix,
          resolutions: [2160, 1080],
        }),
      ],
    })
    const generation = own.generation()

    expect(await get(`?since=1&generation=${generation}`)).toEqual({
      revision: 2,
      generation,
      full: false,
      titles: [
        {
          ...matrix,
          resolutions: [2160, 1080],
        },
      ],
      removed: ['movie:id:604'],
    })
    expect(await get(`?since=2&generation=${generation}`)).toEqual({
      revision: 2,
      generation,
      full: false,
      titles: [],
      removed: [],
    })
  })

  test('serves the whole catalog to a revision from another generation', async () => {
    const { own, get } = serve()
    // The peer's database was reset: it rebuilt its catalog up to revision 1
    // again, so a client's revision 1 from before means nothing now.
    publish(own, {
      radarr: [
        entry(matrix),
      ],
    })

    const response = await get('?since=1&generation=from-before-the-reset')

    expect(response.full).toBe(true)
    expect(response.titles).toEqual([matrix])
  })

  test('merges a title two sources carry', async () => {
    const { own, get } = serve(['radarr-4k', 'radarr-hd'])
    publish(own, {
      'radarr-4k': [
        entry({
          ...matrix,
          resolutions: [2160],
          genres: ['Action'],
        }),
      ],
      'radarr-hd': [
        entry({
          ...matrix,
          totalSize: 50,
          genres: ['Science Fiction'],
        }),
      ],
    })

    expect((await get()).titles).toEqual([
      {
        ...matrix,
        releaseCount: 2,
        totalSize: 150,
        resolutions: [2160, 1080],
        genres: ['Action', 'Science Fiction'],
      },
    ])
  })

  test('drops a source as soon as it is no longer enabled', async () => {
    const { own, get, sources } = serve(['radarr', 'sonarr'])
    publish(own, {
      radarr: [
        entry(matrix),
      ],
      sonarr: [
        entry({ ...reloaded, mediaType: 'tv', tvdbId: 1 }),
      ],
    })

    // The operator turns the Sonarr source off; no sync has run since.
    sources.splice(1, 1)

    expect((await get()).titles).toEqual([matrix])
  })

  test('brings a removed title back as a change', async () => {
    const { own, get } = serve()
    publish(own, {
      radarr: [
        entry(matrix),
      ],
    })
    publish(own, { radarr: [] })
    publish(own, {
      radarr: [
        entry(matrix),
      ],
    })

    expect(await get(`?since=2&generation=${own.generation()}`)).toMatchObject({
      revision: 3,
      full: false,
      titles: [matrix],
      removed: [],
    })
  })
})

describe('GET /peer/search from the catalog cache', () => {
  const matrixRelease: Release = {
    ...release,
    id: 'radarr:movie:1',
    tmdbId: 603,
    imdbId: 'tt0133093',
  }
  const episode = (n: number): Release => ({
    id: `sonarr:episode:${n}`,
    title: `Silo.S01E0${n}`,
    filename: `Silo.S01E0${n}.mkv`,
    category: 5000,
    size: 10,
    tvdbId: 403245,
    tmdbId: 125988,
    seriesTitle: 'Silo',
    season: 1,
    episode: n,
  })
  const matrixTitle: PeerCatalogTitle = {
    mediaType: 'movie',
    tmdbId: 603,
    imdbId: 'tt0133093',
    title: 'The Matrix',
    releaseCount: 1,
    totalSize: 100,
    resolutions: [],
  }
  const siloTitle: PeerCatalogTitle = {
    mediaType: 'tv',
    tvdbId: 403245,
    tmdbId: 125988,
    title: 'Silo',
    releaseCount: 2,
    totalSize: 20,
    resolutions: [],
  }

  function serve(liveSearch = mock(async () => [] as Release[])) {
    const own = new OwnCatalogRepository(openMemoryDatabase())
    const source = (id: string) => ({
      id,
      canSource: true,
      name: id,
      type: 'radarr',
      searchByTmdbId: liveSearch,
      searchByImdbId: liveSearch,
      searchByTvdbId: liveSearch,
      listReleases: liveSearch,
    })
    const sources = [
      source('radarr'),
      source('sonarr'),
    ]
    const app = getPeerRouter(new PeerController(() => sources as any, own))
    const search = async (query = '') => ((await (await app.request(`/search${query}`)).json()) as { items: Release[] }).items
    return { own, search, liveSearch, sources }
  }

  function syncWith(own: OwnCatalogRepository) {
    publish(own, {
      radarr: [
        entry(matrixTitle, [matrixRelease]),
      ],
      sonarr: [
        entry(siloTitle, [
          episode(1),
          episode(2),
        ]),
      ],
    })
  }

  test('asks the sources until every enabled source has been read', async () => {
    const { own, search, liveSearch } = serve(mock(async () => [matrixRelease]))
    // Sonarr (empty) finished its first read; Radarr's is still running.
    own.replaceSource('sonarr', new Map())

    await search('?tmdbId=603')

    expect(liveSearch).toHaveBeenCalled()
  })

  test('asks the sources before the first sync', async () => {
    const { search, liveSearch } = serve(mock(async () => [matrixRelease]))

    expect(await search('?tmdbId=603')).toContainEqual(matrixRelease)
    expect(liveSearch).toHaveBeenCalled()
  })

  test('answers by tmdb and imdb id (with or without tt) without asking the sources', async () => {
    const { own, search, liveSearch } = serve()
    syncWith(own)

    expect(await search('?tmdbId=603')).toEqual([matrixRelease])
    expect(await search('?imdbId=0133093')).toEqual([matrixRelease])
    expect(await search('?imdbId=tt0133093')).toEqual([matrixRelease])
    expect(await search('?tmdbId=999')).toEqual([])
    expect(liveSearch).not.toHaveBeenCalled()
  })

  test('a series\' tmdb id finds nothing, like the sources', async () => {
    const { own, search } = serve()
    syncWith(own)

    expect(await search('?tmdbId=125988')).toEqual([])
  })

  test('answers by tvdb id, narrowed to a season and episode', async () => {
    const { own, search } = serve()
    syncWith(own)

    expect(await search('?tvdbId=403245')).toEqual([
      episode(1),
      episode(2),
    ])
    expect(await search('?tvdbId=403245&season=1&episode=2')).toEqual([
      episode(2),
    ])
  })

  test('lists every release without an id', async () => {
    const { own, search } = serve()
    syncWith(own)

    expect(await search()).toHaveLength(3)
  })

  test('leaves out the releases of a source that is no longer enabled', async () => {
    const { own, search, sources } = serve()
    syncWith(own)

    sources.splice(1, 1)

    expect(await search()).toEqual([matrixRelease])
  })

  test('drops the releases a source no longer has, and only that source\'s', async () => {
    const { own, search } = serve()
    syncWith(own)

    own.replaceSource('sonarr', indexEntries([
      entry({ ...siloTitle, releaseCount: 1, totalSize: 10 }, [
        episode(1),
      ]),
    ]))

    expect(await search()).toEqual([
      matrixRelease,
      episode(1),
    ])
  })
})

describe('RadarrServerConnector.listCatalog', () => {
  test('summarizes movies with files, with artwork and genres from Radarr', async () => {
    server.use(
      http.get('http://radarr.test/api/v3/system/status', () => HttpResponse.json({ appName: 'Radarr', version: '5.0.0' })),
      http.get('http://radarr.test/api/v3/movie', () => HttpResponse.json([
        {
          id: 1,
          title: 'The Matrix',
          tmdbId: 603,
          imdbId: 'tt0133093',
          hasFile: true,
          genres: ['Action', 'Science Fiction'],
          images: [
            { coverType: 'poster', url: '/MediaCover/1/poster.jpg', remoteUrl: 'https://image.tmdb.org/poster.jpg' },
            { coverType: 'fanart', url: '/MediaCover/1/fanart.jpg', remoteUrl: 'https://image.tmdb.org/fanart.jpg' },
          ],
          movieFile: {
            path: '/movies/The.Matrix.1999.2160p.mkv',
            size: 100,
            quality: {
              quality: { resolution: 2160 },
            },
          },
        },
        {
          id: 2,
          title: 'Not Downloaded',
          tmdbId: 604,
          hasFile: false,
        },
      ])),
    )
    const radarr = new RadarrServerConnector({
      url: 'http://radarr.test',
      apiKey: 'a'.repeat(32),
      name: 'Radarr',
      source: true,
      destination: false,
      autoregister: { enable: false, priority: 1 },
    })

    const entries = await radarr.listCatalog()

    expect(entries.map(entry => entry.title)).toEqual([
      {
        mediaType: 'movie',
        tmdbId: 603,
        imdbId: 'tt0133093',
        title: 'The Matrix',
        releaseCount: 1,
        totalSize: 100,
        resolutions: [2160],
        posterUrl: 'https://image.tmdb.org/poster.jpg',
        backdropUrl: 'https://image.tmdb.org/fanart.jpg',
        genres: ['Action', 'Science Fiction'],
      },
    ])
    expect(entries[0]!.releases).toMatchObject([
      {
        filename: 'The.Matrix.1999.2160p.mkv',
        size: 100,
        tmdbId: 603,
        movieTitle: 'The Matrix',
      },
    ])
  })

  test('looks up a single movie by tmdbId instead of listing the library', async () => {
    const queries: Array<string | null> = []
    server.use(
      http.get('http://radarr.test/api/v3/system/status', () => HttpResponse.json({ appName: 'Radarr', version: '5.0.0' })),
      http.get('http://radarr.test/api/v3/movie', ({ request }) => {
        queries.push(new URL(request.url).searchParams.get('tmdbId'))
        return HttpResponse.json([
          {
            id: 1,
            title: 'The Matrix',
            tmdbId: 603,
            hasFile: true,
            movieFile: { path: '/m/The.Matrix.mkv', size: 100 },
          },
        ])
      }),
    )
    const radarr = new RadarrServerConnector({
      url: 'http://radarr.test',
      apiKey: 'a'.repeat(32),
      name: 'Radarr',
      source: true,
      destination: false,
      autoregister: { enable: false, priority: 1 },
    })

    expect((await radarr.listCatalog({ tmdbId: 603 })).map(entry => entry.title.title)).toEqual(['The Matrix'])
    // A series id means nothing to Radarr: no request at all.
    expect(await radarr.listCatalog({ tvdbId: 1396 })).toEqual([])
    expect(queries).toEqual(['603'])
  })
})
