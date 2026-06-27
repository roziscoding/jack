import type { Release } from '../lib/release'
import { describe, expect, mock, test } from 'bun:test'
import { BadRequestError } from '../lib/errors/BadRequestError'
import { NotFoundError } from '../lib/errors/NotFoundError'
import { CatalogController } from '../modules/catalog/catalog.controller'
import { groupReleasesIntoTitles, mapLimit } from '../modules/catalog/catalog.lib'

function movie(overrides: Partial<Release> = {}): Release {
  return {
    id: `movie:${Math.random()}`,
    title: 'Movie.2024.1080p',
    filename: 'Movie.2024.1080p.mkv',
    category: 2000,
    size: 100,
    ...overrides,
  }
}

function episode(overrides: Partial<Release> = {}): Release {
  return {
    id: `episode:${Math.random()}`,
    title: 'Show.S01E01.1080p',
    filename: 'Show.S01E01.1080p.mkv',
    category: 5000,
    size: 50,
    ...overrides,
  }
}

describe('groupReleasesIntoTitles', () => {
  test('groups movie + tv releases by their strong ids', () => {
    const releases: Release[] = [
      movie({ tmdbId: 603, size: 100 }),
      movie({ tmdbId: 603, size: 200, quality: { resolution: 1080 } }),
      movie({ tmdbId: 603, size: 300, quality: { resolution: 2160 } }),
      episode({ tvdbId: 1396, seriesTitle: 'Breaking Bad', size: 50 }),
      episode({ tvdbId: 1396, seriesTitle: 'Breaking Bad', size: 60 }),
    ]

    const titles = groupReleasesIntoTitles(releases)

    expect(titles).toHaveLength(2)

    const movieTitle = titles.find(t => t.mediaType === 'movie')
    expect(movieTitle).toBeDefined()
    expect(movieTitle!.tmdbId).toBe(603)
    expect(movieTitle!.releaseCount).toBe(3)
    expect(movieTitle!.totalSize).toBe(600)

    const tvTitle = titles.find(t => t.mediaType === 'tv')
    expect(tvTitle).toBeDefined()
    expect(tvTitle!.tvdbId).toBe(1396)
    expect(tvTitle!.releaseCount).toBe(2)
    expect(tvTitle!.totalSize).toBe(110)
    expect(tvTitle!.displayTitle).toBe('Breaking Bad')
  })

  test('collapses id-less movies with the same title into one name-keyed entry', () => {
    const releases: Release[] = [
      movie({ title: 'Foo.2024', size: 100 }),
      movie({ title: 'Foo.2024', size: 200 }),
    ]

    const titles = groupReleasesIntoTitles(releases)

    expect(titles).toHaveLength(1)
    expect(titles[0]!.releaseCount).toBe(2)
    expect(titles[0]!.totalSize).toBe(300)
    expect(titles[0]!.key).toContain('name:')
  })

  test('aliases an id-less tv release into the strong-id bucket of the same series', () => {
    const releases: Release[] = [
      episode({ seriesTitle: 'Some Show', size: 50 }),
      episode({ seriesTitle: 'Some Show', tvdbId: 999, size: 60 }),
    ]

    const titles = groupReleasesIntoTitles(releases)

    expect(titles).toHaveLength(1)
    expect(titles[0]!.releaseCount).toBe(2)
    expect(titles[0]!.tvdbId).toBe(999)
    expect(titles[0]!.key).toContain('id:999')
  })

  test('sorts titles by display title', () => {
    const releases: Release[] = [
      movie({ title: 'Zebra', tmdbId: 1 }),
      movie({ title: 'Apple', tmdbId: 2 }),
    ]

    const titles = groupReleasesIntoTitles(releases)

    expect(titles.map(t => t.displayTitle)).toEqual(['Apple', 'Zebra'])
  })
})

describe('catalogController', () => {
  function makeConnectors(peers: any[]) {
    return { servers: [], peers }
  }

  test('returns the peer and its grouped titles', async () => {
    const peer = {
      id: 'peer-1',
      name: 'Friend Jack',
      listReleases: async () => [movie({ tmdbId: 603 }), movie({ tmdbId: 603 })],
    }
    const controller = new CatalogController(makeConnectors([peer]) as any)

    const result = await controller.getPeerCatalog('peer-1')

    expect(result.peer).toEqual({ id: 'peer-1', name: 'Friend Jack' })
    expect(result.titles).toHaveLength(1)
    expect(result.titles[0]!.releaseCount).toBe(2)
  })

  test('throws NotFoundError for an unknown peer id', () => {
    const controller = new CatalogController(makeConnectors([]) as any)

    expect(controller.getPeerCatalog('missing')).rejects.toBeInstanceOf(NotFoundError)
  })
})

describe('mapLimit', () => {
  test('preserves input order regardless of completion order', async () => {
    const result = await mapLimit([3, 1, 2], 2, async (n) => {
      await new Promise(resolve => setTimeout(resolve, n))
      return n * 10
    })

    expect(result).toEqual([30, 10, 20])
  })

  test('runs exactly `limit` tasks in flight, never more', async () => {
    let inFlight = 0
    let peak = 0

    await mapLimit([1, 2, 3, 4, 5, 6], 2, async () => {
      inFlight += 1
      peak = Math.max(peak, inFlight)
      await new Promise(resolve => setTimeout(resolve, 5))
      inFlight -= 1
      return null
    })

    // Saturates the cap (catches a collapse-to-one-worker regression) without exceeding it.
    expect(peak).toBe(2)
  })

  test('returns an empty array for empty input', async () => {
    expect(await mapLimit([], 4, async () => 1)).toEqual([])
  })
})

describe('catalogController enrichment', () => {
  function makeConnectors(peers: any[]) {
    return { servers: [], peers }
  }

  const breakingBad = {
    tmdbId: 1396,
    title: 'Breaking Bad',
    overview: 'A chemistry teacher cooks meth.',
    year: 2008,
    rating: 8.9,
    posterUrl: 'https://image.tmdb.org/t/p/w500/poster.jpg',
    backdropUrl: 'https://image.tmdb.org/t/p/w780/backdrop.jpg',
    genres: ['Drama'],
  }

  test('attaches metadata to titles with a tmdbId and leaves id-less titles untouched', async () => {
    const calls: Array<[string, number]> = []
    const tmdb = {
      getMetadata: async (mediaType: string, tmdbId: number) => {
        calls.push([mediaType, tmdbId])
        return tmdbId === 603 ? { ...breakingBad, tmdbId: 603, title: 'The Matrix' } : null
      },
    }
    const peer = {
      id: 'peer-1',
      name: 'Friend Jack',
      listReleases: async () => [
        movie({ tmdbId: 603, title: 'The.Matrix.1999' }),
        movie({ title: 'No.Id.2024' }),
      ],
    }
    const controller = new CatalogController(makeConnectors([peer]) as any, tmdb as any)

    const result = await controller.getPeerCatalog('peer-1')

    const enriched = result.titles.find(t => t.tmdbId === 603)
    expect(enriched!.metadata).toMatchObject({ title: 'The Matrix' })

    const idless = result.titles.find(t => t.tmdbId == null)
    expect(idless!.metadata).toBeUndefined()

    // No lookup is attempted for the id-less title.
    expect(calls).toEqual([['movie', 603]])
  })

  test('keeps the catalog intact when a getMetadata lookup rejects', async () => {
    const tmdb = {
      getMetadata: async (_mediaType: string, tmdbId: number) => {
        if (tmdbId === 603)
          throw new Error('TMDB exploded')
        return { ...breakingBad }
      },
    }
    const peer = {
      id: 'peer-1',
      name: 'Friend Jack',
      listReleases: async () => [
        movie({ tmdbId: 603, title: 'The.Matrix.1999' }),
        episode({ tvdbId: 1, tmdbId: 1396, seriesTitle: 'Breaking Bad' }),
      ],
    }
    const controller = new CatalogController(makeConnectors([peer]) as any, tmdb as any)

    const result = await controller.getPeerCatalog('peer-1')

    const failed = result.titles.find(t => t.tmdbId === 603)
    expect(failed!.metadata).toBeUndefined()

    const ok = result.titles.find(t => t.mediaType === 'tv')
    expect(ok!.metadata).toMatchObject({ title: 'Breaking Bad' })
  })

  test('makes no TMDB calls and attaches no metadata when no client is configured', async () => {
    const peer = {
      id: 'peer-1',
      name: 'Friend Jack',
      listReleases: async () => [movie({ tmdbId: 603 })],
    }
    const controller = new CatalogController(makeConnectors([peer]) as any)

    const result = await controller.getPeerCatalog('peer-1')

    expect(result.titles[0]!.metadata).toBeUndefined()
  })
})

describe('catalogController.getRequestOptions', () => {
  function fakeServer(overrides: Partial<{
    id: string
    name: string
    type: 'radarr' | 'sonarr'
    canDestination: boolean
    isInitialized: boolean
    getRootFolders: () => Promise<Array<{ path: string, freeSpace?: number }>>
  }> = {}) {
    return {
      id: 'radarr-1',
      name: 'Radarr',
      type: 'radarr',
      canDestination: true,
      isInitialized: true,
      getRootFolders: async () => [{ path: '/movies', freeSpace: 1000 }],
      ...overrides,
    }
  }

  function makeConnectors(servers: any[]) {
    return { servers, peers: [] }
  }

  test('returns only initialized destinations and tags movies with mediaType "movie"', async () => {
    const radarr = fakeServer({ id: 'radarr-1', name: 'My Radarr', type: 'radarr' })
    const sonarrSourceOnly = fakeServer({ id: 'sonarr-1', name: 'Source Sonarr', type: 'sonarr', canDestination: false })
    const controller = new CatalogController(makeConnectors([radarr, sonarrSourceOnly]) as any)

    const options = await controller.getRequestOptions()

    expect(options).toHaveLength(1)
    expect(options[0]!.id).toBe('radarr-1')
    expect(options[0]!.name).toBe('My Radarr')
    expect(options[0]!.type).toBe('radarr')
    expect(options[0]!.mediaType).toBe('movie')
    expect(options[0]!).not.toHaveProperty('qualityProfiles')
    expect(options[0]!.rootFolders).toEqual([{ path: '/movies', freeSpace: 1000 }])
  })

  test('tags a destination Sonarr with mediaType "tv"', async () => {
    const sonarr = fakeServer({
      id: 'sonarr-1',
      name: 'My Sonarr',
      type: 'sonarr',
      getRootFolders: async () => [{ path: '/tv' }],
    })
    const controller = new CatalogController(makeConnectors([sonarr]) as any)

    const options = await controller.getRequestOptions()

    expect(options).toHaveLength(1)
    expect(options[0]!.mediaType).toBe('tv')
  })

  test('excludes destinations that are not initialized', async () => {
    const radarr = fakeServer({ isInitialized: false })
    const controller = new CatalogController(makeConnectors([radarr]) as any)

    expect(await controller.getRequestOptions()).toEqual([])
  })

  test('skips a destination whose getRootFolders rejects but keeps others', async () => {
    const broken = fakeServer({
      id: 'radarr-broken',
      name: 'Broken Radarr',
      getRootFolders: async () => {
        throw new Error('unreachable')
      },
    })
    const healthy = fakeServer({ id: 'radarr-ok', name: 'Healthy Radarr' })
    const controller = new CatalogController(makeConnectors([broken, healthy]) as any)

    const options = await controller.getRequestOptions()

    expect(options).toHaveLength(1)
    expect(options[0]!.id).toBe('radarr-ok')
  })
})

describe('catalogController.requestDownload', () => {
  function fakeServer(overrides: Partial<{
    id: string
    name: string
    type: 'radarr' | 'sonarr'
    canDestination: boolean
    ensureJackQualityProfile: () => Promise<number>
    addAndSearch: (params: any) => Promise<void>
  }> = {}) {
    return {
      id: 'radarr-1',
      name: 'My Radarr',
      type: 'radarr',
      canDestination: true,
      ensureJackQualityProfile: mock(async () => 77),
      addAndSearch: mock(async () => {}),
      ...overrides,
    }
  }

  function makeConnectors(servers: any[]) {
    return { servers, peers: [] }
  }

  test('throws NotFoundError for an unknown serverId', () => {
    const controller = new CatalogController(makeConnectors([]) as any)

    expect(controller.requestDownload({
      serverId: 'missing',
      mediaType: 'movie',
      tmdbId: 603,
      rootFolderPath: '/movies',
    })).rejects.toBeInstanceOf(NotFoundError)
  })

  test('throws BadRequestError when the server is not a destination', () => {
    const radarr = fakeServer({ canDestination: false })
    const controller = new CatalogController(makeConnectors([radarr]) as any)

    expect(controller.requestDownload({
      serverId: 'radarr-1',
      mediaType: 'movie',
      tmdbId: 603,
      rootFolderPath: '/movies',
    })).rejects.toBeInstanceOf(BadRequestError)
  })

  test('throws BadRequestError when a movie request targets a Sonarr server', () => {
    const sonarr = fakeServer({ id: 'sonarr-1', name: 'My Sonarr', type: 'sonarr' })
    const controller = new CatalogController(makeConnectors([sonarr]) as any)

    expect(controller.requestDownload({
      serverId: 'sonarr-1',
      mediaType: 'movie',
      tmdbId: 603,
      rootFolderPath: '/movies',
    })).rejects.toBeInstanceOf(BadRequestError)
  })

  test('throws BadRequestError when a tv request targets a Radarr server', () => {
    const radarr = fakeServer()
    const controller = new CatalogController(makeConnectors([radarr]) as any)

    expect(controller.requestDownload({
      serverId: 'radarr-1',
      mediaType: 'tv',
      tvdbId: 81189,
      rootFolderPath: '/tv',
    })).rejects.toBeInstanceOf(BadRequestError)
  })

  test('calls addAndSearch and returns ok for a valid matching request', async () => {
    const radarr = fakeServer()
    const controller = new CatalogController(makeConnectors([radarr]) as any)

    const result = await controller.requestDownload({
      serverId: 'radarr-1',
      mediaType: 'movie',
      tmdbId: 603,
      rootFolderPath: '/movies',
    })

    expect(result).toEqual({ ok: true, server: 'My Radarr' })
    expect(radarr.ensureJackQualityProfile).toHaveBeenCalledTimes(1)
    expect(radarr.addAndSearch).toHaveBeenCalledTimes(1)
    // The Jack profile (77) is forced regardless of any client input.
    expect(radarr.addAndSearch).toHaveBeenCalledWith({
      tmdbId: 603,
      tvdbId: undefined,
      qualityProfileId: 77,
      rootFolderPath: '/movies',
    })
  })

  test('routes a tv request to the matching Sonarr destination', async () => {
    const sonarr = fakeServer({ id: 'sonarr-1', name: 'My Sonarr', type: 'sonarr' })
    const controller = new CatalogController(makeConnectors([sonarr]) as any)

    const result = await controller.requestDownload({
      serverId: 'sonarr-1',
      mediaType: 'tv',
      tvdbId: 81189,
      rootFolderPath: '/tv',
    })

    expect(result).toEqual({ ok: true, server: 'My Sonarr' })
    expect(sonarr.addAndSearch).toHaveBeenCalledWith({
      tmdbId: undefined,
      tvdbId: 81189,
      qualityProfileId: 77,
      rootFolderPath: '/tv',
    })
  })
})

describe('catalogController.getTmdbStatus', () => {
  function makeConnectors() {
    return { servers: [], peers: [] }
  }

  test('reports not configured when no tmdb client is supplied', async () => {
    const controller = new CatalogController(makeConnectors() as any)

    expect(await controller.getTmdbStatus()).toEqual({ configured: false, ok: false })
  })

  test('reports ok when the client ping resolves true', async () => {
    const tmdb = { ping: async () => true }
    const controller = new CatalogController(makeConnectors() as any, tmdb as any)

    expect(await controller.getTmdbStatus()).toEqual({ configured: true, ok: true })
  })

  test('reports configured but not ok when the client ping resolves false', async () => {
    const tmdb = { ping: async () => false }
    const controller = new CatalogController(makeConnectors() as any, tmdb as any)

    expect(await controller.getTmdbStatus()).toEqual({ configured: true, ok: false })
  })

  test('reports the error message when the client ping throws', async () => {
    const tmdb = {
      ping: async () => {
        throw new Error('boom')
      },
    }
    const controller = new CatalogController(makeConnectors() as any, tmdb as any)

    expect(await controller.getTmdbStatus()).toEqual({ configured: true, ok: false, error: 'boom' })
  })
})
