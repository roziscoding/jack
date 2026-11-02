import type { PeerCatalogTitle } from '../lib/peer-catalog'
import type { Release } from '../lib/release'
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

  test('asks a 0.2.0+ peer for the changes since a revision', async () => {
    const peer = await connectedPeer('0.2.0')
    const title: PeerCatalogTitle = {
      mediaType: 'movie',
      tmdbId: 603,
      title: 'The Matrix',
      releaseCount: 1,
      totalSize: 100,
      resolutions: [2160],
    }
    const seen: Array<string | null> = []
    server.use(http.get('http://peer.test/peer/catalog', ({ request }) => {
      seen.push(new URL(request.url).searchParams.get('since'))
      return HttpResponse.json({
        revision: 7,
        full: false,
        titles: [title],
        removed: ['movie:id:604'],
      })
    }))

    expect(await peer.listCatalog(5)).toEqual({
      kind: 'titles',
      revision: 7,
      full: false,
      titles: [title],
      removed: ['movie:id:604'],
    })
    await peer.listCatalog()
    expect(seen).toEqual(['5', null])
  })
})

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

  function serve() {
    const own = new OwnCatalogRepository(openMemoryDatabase())
    const app = getPeerRouter(new PeerController(() => [], own))
    const get = async (query = '') => (await app.request(`/catalog${query}`)).json()
    return { own, get }
  }

  // The catalog as the sources would report it, without releases.
  function snapshot(...titles: PeerCatalogTitle[]) {
    return indexEntries(titles.map(title => ({ title, releases: [] })))
  }

  test('serves the whole catalog without `since`', async () => {
    const { own, get } = serve()
    own.applySnapshot(snapshot(matrix, reloaded))

    expect(await get()).toEqual({
      revision: 1,
      full: true,
      titles: [matrix, reloaded],
      removed: [],
    })
  })

  test('serves only what changed after `since`, removals included', async () => {
    const { own, get } = serve()
    own.applySnapshot(snapshot(matrix, reloaded))
    own.applySnapshot(snapshot({
      ...matrix,
      resolutions: [2160, 1080],
    }))

    expect(await get('?since=1')).toEqual({
      revision: 2,
      full: false,
      titles: [
        {
          ...matrix,
          resolutions: [2160, 1080],
        },
      ],
      removed: ['movie:id:604'],
    })
    expect(await get('?since=2')).toEqual({
      revision: 2,
      full: false,
      titles: [],
      removed: [],
    })
  })

  test('serves the whole catalog when `since` is newer than anything here', async () => {
    const { own, get } = serve()
    own.applySnapshot(snapshot(matrix))

    expect(await get('?since=99')).toEqual({
      revision: 1,
      full: true,
      titles: [matrix],
      removed: [],
    })
  })

  test('brings a removed title back as a change', async () => {
    const { own, get } = serve()
    own.applySnapshot(snapshot(matrix))
    own.applySnapshot(new Map())
    own.applySnapshot(snapshot(matrix))

    expect(await get('?since=2')).toEqual({
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
    id: 'src:movie:1',
    tmdbId: 603,
    imdbId: 'tt0133093',
  }
  const episode = (n: number): Release => ({
    id: `src:episode:${n}`,
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

  function serve(liveSearch = mock(async () => [] as Release[])) {
    const own = new OwnCatalogRepository(openMemoryDatabase())
    const source = {
      canSource: true,
      name: 'Radarr',
      type: 'radarr',
      searchByTmdbId: liveSearch,
      searchByImdbId: liveSearch,
      searchByTvdbId: liveSearch,
      listReleases: liveSearch,
    }
    const app = getPeerRouter(new PeerController(() => [source] as any, own))
    const search = async (query = '') => ((await (await app.request(`/search${query}`)).json()) as { items: Release[] }).items
    return { own, search, liveSearch }
  }

  function syncWith(own: OwnCatalogRepository) {
    own.applySnapshot(indexEntries([
      {
        title: {
          mediaType: 'movie',
          tmdbId: 603,
          imdbId: 'tt0133093',
          title: 'The Matrix',
          releaseCount: 1,
          totalSize: 100,
          resolutions: [],
        },
        releases: [matrixRelease],
      },
      {
        title: {
          mediaType: 'tv',
          tvdbId: 403245,
          tmdbId: 125988,
          title: 'Silo',
          releaseCount: 2,
          totalSize: 20,
          resolutions: [],
        },
        releases: [
          episode(1),
          episode(2),
        ],
      },
    ]))
  }

  test('asks the sources before the first sync', async () => {
    const { search, liveSearch } = serve(mock(async () => [matrixRelease]))

    expect(await search('?tmdbId=603')).toEqual([matrixRelease])
    expect(liveSearch).toHaveBeenCalledTimes(1)
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

  test('drops the releases of a title that is gone, and only those', async () => {
    const { own, search } = serve()
    syncWith(own)

    own.applySnapshot(indexEntries([
      {
        title: {
          mediaType: 'tv',
          tvdbId: 403245,
          tmdbId: 125988,
          title: 'Silo',
          releaseCount: 1,
          totalSize: 10,
          resolutions: [],
        },
        releases: [
          episode(1),
        ],
      },
    ]))

    expect(await search()).toEqual([
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
