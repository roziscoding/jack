import type { Release } from '../lib/release'
import type { DownloadsService, StartQbDownloadResult } from '../modules/downloads/downloads.service'
import { describe, expect, mock, test } from 'bun:test'
import { BadRequestError } from '../lib/errors/BadRequestError'
import { NotFoundError } from '../lib/errors/NotFoundError'
import { CatalogController } from '../modules/catalog/catalog.controller'
import { groupReleasesIntoUnifiedTitles, pickBestPerEpisode, pickBestRelease } from '../modules/catalog/catalog.lib'

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

describe('groupReleasesIntoUnifiedTitles', () => {
  test('unifies the same movie across two peers into one title with per-peer buckets', () => {
    const titles = groupReleasesIntoUnifiedTitles([
      { peer: { id: 'p1', name: 'Alpha' }, releases: [movie({ tmdbId: 603, size: 100 })] },
      { peer: { id: 'p2', name: 'Beta' }, releases: [movie({ tmdbId: 603, size: 200 })] },
    ])

    expect(titles).toHaveLength(1)
    expect(titles[0]!.tmdbId).toBe(603)
    expect(titles[0]!.releaseCount).toBe(2)
    expect(titles[0]!.totalSize).toBe(300)
    expect(titles[0]!.peers).toHaveLength(2)

    const alpha = titles[0]!.peers.find(p => p.id === 'p1')!
    expect(alpha.name).toBe('Alpha')
    expect(alpha.releaseCount).toBe(1)
    expect(alpha.totalSize).toBe(100)
  })

  test('preserves per-release detail in each peer bucket', () => {
    const titles = groupReleasesIntoUnifiedTitles([
      { peer: { id: 'p1', name: 'Alpha' }, releases: [
        episode({ id: 'ep:1', tvdbId: 1396, seriesTitle: 'Breaking Bad', season: 1, episode: 1, size: 50, quality: { resolution: 1080 } }),
      ] },
    ])

    const bucket = titles[0]!.peers[0]!
    expect(bucket.releases).toHaveLength(1)
    expect(bucket.releases[0]).toMatchObject({
      id: 'ep:1',
      filename: 'Show.S01E01.1080p.mkv',
      size: 50,
      season: 1,
      episode: 1,
      quality: { resolution: 1080 },
    })
  })

  test('collapses an id-less release on one peer into the strong-id bucket from another peer', () => {
    const titles = groupReleasesIntoUnifiedTitles([
      { peer: { id: 'p1', name: 'Alpha' }, releases: [episode({ seriesTitle: 'Some Show', size: 50 })] },
      { peer: { id: 'p2', name: 'Beta' }, releases: [episode({ seriesTitle: 'Some Show', tvdbId: 999, size: 60 })] },
    ])

    expect(titles).toHaveLength(1)
    expect(titles[0]!.tvdbId).toBe(999)
    expect(titles[0]!.key).toContain('id:999')
    expect(titles[0]!.peers.map(p => p.id).sort()).toEqual(['p1', 'p2'])
  })

  test('does not alias id-less same-name releases when strong ids are ambiguous', () => {
    const titles = groupReleasesIntoUnifiedTitles([
      { peer: { id: 'p1', name: 'Alpha' }, releases: [movie({ title: 'The Thing', tmdbId: 1091 })] },
      { peer: { id: 'p2', name: 'Beta' }, releases: [movie({ title: 'The Thing', tmdbId: 609 })] },
      { peer: { id: 'p3', name: 'Gamma' }, releases: [movie({ title: 'The Thing' })] },
    ])

    const strongIds = titles
      .map(title => title.tmdbId)
      .filter((tmdbId): tmdbId is number => tmdbId != null)
      .sort((a, b) => a - b)
    const idLess = titles.find(title => title.key === 'movie:name:the thing')

    expect(strongIds).toEqual([609, 1091])
    expect(idLess?.releaseCount).toBe(1)
    expect(idLess?.tmdbId).toBeUndefined()
  })

  test('sorts unified titles by display title', () => {
    const titles = groupReleasesIntoUnifiedTitles([
      { peer: { id: 'p1', name: 'Alpha' }, releases: [movie({ title: 'Zebra', tmdbId: 1 }), movie({ title: 'Apple', tmdbId: 2 })] },
    ])

    expect(titles.map(t => t.displayTitle)).toEqual(['Apple', 'Zebra'])
  })
})

describe('pickBestRelease', () => {
  test('returns undefined for an empty list', () => {
    expect(pickBestRelease([])).toBeUndefined()
  })

  test('prefers the higher resolution even when a lower one has a larger file', () => {
    const sd = movie({ id: 'a', quality: { resolution: 720 }, size: 999 })
    const hd = movie({ id: 'b', quality: { resolution: 1080 }, size: 1 })
    expect(pickBestRelease([sd, hd])).toBe(hd)
  })

  test('breaks a resolution tie by the larger file', () => {
    const small = movie({ id: 'a', quality: { resolution: 1080 }, size: 10 })
    const big = movie({ id: 'b', quality: { resolution: 1080 }, size: 20 })
    expect(pickBestRelease([small, big])).toBe(big)
  })

  test('breaks a full tie deterministically by the lowest release id, regardless of input order', () => {
    const z = movie({ id: 'zzz', quality: { resolution: 1080 }, size: 10 })
    const a = movie({ id: 'aaa', quality: { resolution: 1080 }, size: 10 })
    expect(pickBestRelease([z, a])).toBe(a)
    expect(pickBestRelease([a, z])).toBe(a)
  })
})

describe('pickBestPerEpisode', () => {
  test('keeps the best release per season/episode key', () => {
    const s1e1Sd = episode({ id: 'a', season: 1, episode: 1, quality: { resolution: 720 } })
    const s1e1Hd = episode({ id: 'b', season: 1, episode: 1, quality: { resolution: 1080 } })
    const s1e2 = episode({ id: 'c', season: 1, episode: 2, quality: { resolution: 720 } })
    const best = pickBestPerEpisode([s1e1Sd, s1e1Hd, s1e2])
    expect(best).toHaveLength(2)
    expect(best).toContain(s1e1Hd)
    expect(best).toContain(s1e2)
    expect(best).not.toContain(s1e1Sd)
  })

  test('keeps unnumbered episode releases separate instead of collapsing them to one slot', () => {
    const first = episode({ id: 'unparsed:1', tvdbId: 81189, title: 'Show.Special.A', filename: 'Show.Special.A.mkv', quality: { resolution: 720 } })
    const second = episode({ id: 'unparsed:2', tvdbId: 81189, title: 'Show.Special.B', filename: 'Show.Special.B.mkv', quality: { resolution: 1080 } })

    const best = pickBestPerEpisode([first, second])

    expect(best).toHaveLength(2)
    expect(best).toContain(first)
    expect(best).toContain(second)
  })
})

describe('catalogController.getCatalog', () => {
  function makeConnectors(peers: any[]) {
    return { servers: [], peers }
  }

  test('aggregates the same title across two initialized peers', async () => {
    const p1 = { id: 'p1', name: 'Alpha', isInitialized: true, listReleases: async () => [movie({ tmdbId: 603, size: 100 })] }
    const p2 = { id: 'p2', name: 'Beta', isInitialized: true, listReleases: async () => [movie({ tmdbId: 603, size: 200 })] }
    const controller = new CatalogController(makeConnectors([p1, p2]) as any)

    const result = await controller.getCatalog()

    expect(result.peers).toEqual([{ id: 'p1', name: 'Alpha' }, { id: 'p2', name: 'Beta' }])
    expect(result.titles).toHaveLength(1)
    expect(result.titles[0]!.releaseCount).toBe(2)
    expect(result.titles[0]!.peers).toHaveLength(2)
  })

  test('skips a peer whose listReleases rejects but keeps the rest', async () => {
    const broken = {
      id: 'p1',
      name: 'Broken',
      isInitialized: true,
      listReleases: async () => {
        throw new Error('unreachable')
      },
    }
    const healthy = { id: 'p2', name: 'Healthy', isInitialized: true, listReleases: async () => [movie({ tmdbId: 603 })] }
    const controller = new CatalogController(makeConnectors([broken, healthy]) as any)

    const result = await controller.getCatalog()

    expect(result.peers).toEqual([{ id: 'p2', name: 'Healthy' }])
    expect(result.titles).toHaveLength(1)
  })

  test('does not query uninitialized peers', async () => {
    const called = mock(async () => [movie({ tmdbId: 603 })])
    const peer = { id: 'p1', name: 'Offline', isInitialized: false, listReleases: called }
    const controller = new CatalogController(makeConnectors([peer]) as any)

    const result = await controller.getCatalog()

    expect(called).not.toHaveBeenCalled()
    expect(result.peers).toEqual([])
    expect(result.titles).toEqual([])
  })
})

describe('catalogController.getTitleMetadata', () => {
  function makeConnectors() {
    return { servers: [], peers: [] }
  }

  const matrix = {
    tmdbId: 603,
    title: 'The Matrix',
    overview: 'A hacker learns the truth.',
    year: 1999,
    rating: 8.2,
    posterUrl: 'https://image.tmdb.org/t/p/w500/poster.jpg',
    backdropUrl: 'https://image.tmdb.org/t/p/w780/backdrop.jpg',
    genres: ['Action'],
  }

  test('delegates to the tmdb client and returns its metadata', async () => {
    const getMetadata = mock(async () => matrix)
    const controller = new CatalogController(makeConnectors() as any, { getMetadata } as any)

    const result = await controller.getTitleMetadata('movie', 603)

    expect(result).toMatchObject({ title: 'The Matrix' })
    expect(getMetadata).toHaveBeenCalledWith('movie', 603)
  })

  test('returns null when no tmdb client is configured', async () => {
    const controller = new CatalogController(makeConnectors() as any)

    expect(await controller.getTitleMetadata('movie', 603)).toBeNull()
  })

  test('propagates a lookup rejection to the caller', () => {
    const getMetadata = mock(async () => {
      throw new Error('TMDB exploded')
    })
    const controller = new CatalogController(makeConnectors() as any, { getMetadata } as any)

    expect(controller.getTitleMetadata('movie', 603)).rejects.toThrow('TMDB exploded')
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
    add: (params: any) => Promise<number>
  }> = {}) {
    return {
      id: 'radarr-1',
      name: 'My Radarr',
      type: 'radarr',
      canDestination: true,
      add: mock(async () => 123),
      ...overrides,
    }
  }

  function fakePeer(overrides: Partial<{
    searchByTmdbId: (tmdbId: string) => Promise<Release[]>
    searchByTvdbId: (tvdbId: string) => Promise<Release[]>
  }> = {}) {
    return {
      id: 'peer-1',
      name: 'Friend Jack',
      searchByTmdbId: overrides.searchByTmdbId ?? mock(async () => [movie({ id: 'rel:1', tmdbId: 603, quality: { resolution: 1080 } })]),
      searchByTvdbId: overrides.searchByTvdbId ?? mock(async () => [episode({ id: 'ep:1', tvdbId: 81189, season: 1, episode: 1, quality: { resolution: 1080 } })]),
    }
  }

  function fakeDownloads(overrides: Partial<{ startDirectDownload: (input: unknown) => Promise<StartQbDownloadResult> }> = {}): DownloadsService {
    const testDouble = {
      startDirectDownload: overrides.startDirectDownload ?? mock(async () => 'started' as const),
    }
    return testDouble as unknown as DownloadsService
  }

  function makeConnectors(servers: any[], peers: any[] = []) {
    return { servers, peers }
  }

  test('throws BadRequestError when downloads are not configured', () => {
    const radarr = fakeServer()
    const controller = new CatalogController(makeConnectors([radarr], [fakePeer()]) as any)

    expect(controller.requestDownload({
      peerId: 'peer-1',
      serverId: 'radarr-1',
      mediaType: 'movie',
      tmdbId: 603,
      rootFolderPath: '/movies',
    })).rejects.toBeInstanceOf(BadRequestError)
  })

  test('throws NotFoundError for an unknown serverId', () => {
    const controller = new CatalogController(makeConnectors([], [fakePeer()]) as any, undefined, fakeDownloads() as any)

    expect(controller.requestDownload({
      peerId: 'peer-1',
      serverId: 'missing',
      mediaType: 'movie',
      tmdbId: 603,
      rootFolderPath: '/movies',
    })).rejects.toBeInstanceOf(NotFoundError)
  })

  test('throws BadRequestError when the server is not a destination', () => {
    const radarr = fakeServer({ canDestination: false })
    const controller = new CatalogController(makeConnectors([radarr], [fakePeer()]) as any, undefined, fakeDownloads() as any)

    expect(controller.requestDownload({
      peerId: 'peer-1',
      serverId: 'radarr-1',
      mediaType: 'movie',
      tmdbId: 603,
      rootFolderPath: '/movies',
    })).rejects.toBeInstanceOf(BadRequestError)
  })

  test('throws BadRequestError when a movie request targets a Sonarr server', () => {
    const sonarr = fakeServer({ id: 'sonarr-1', name: 'My Sonarr', type: 'sonarr' })
    const controller = new CatalogController(makeConnectors([sonarr], [fakePeer()]) as any, undefined, fakeDownloads() as any)

    expect(controller.requestDownload({
      peerId: 'peer-1',
      serverId: 'sonarr-1',
      mediaType: 'movie',
      tmdbId: 603,
      rootFolderPath: '/movies',
    })).rejects.toBeInstanceOf(BadRequestError)
  })

  test('throws BadRequestError when a tv request has no tvdbId', () => {
    const sonarr = fakeServer({ id: 'sonarr-1', name: 'My Sonarr', type: 'sonarr' })
    const controller = new CatalogController(makeConnectors([sonarr], [fakePeer()]) as any, undefined, fakeDownloads() as any)

    expect(controller.requestDownload({
      peerId: 'peer-1',
      serverId: 'sonarr-1',
      mediaType: 'tv',
      rootFolderPath: '/tv',
    })).rejects.toBeInstanceOf(BadRequestError)
  })

  test('throws NotFoundError when the peer has no release for the tmdbId, and does not add', async () => {
    const radarr = fakeServer()
    const peer = fakePeer({ searchByTmdbId: mock(async () => []) })
    const controller = new CatalogController(makeConnectors([radarr], [peer]) as any, undefined, fakeDownloads() as any)

    await expect(controller.requestDownload({
      peerId: 'peer-1',
      serverId: 'radarr-1',
      mediaType: 'movie',
      tmdbId: 603,
      rootFolderPath: '/movies',
    })).rejects.toBeInstanceOf(NotFoundError)
    expect(radarr.add).not.toHaveBeenCalled()
  })

  test('adds the movie without search and starts a direct download for the best release', async () => {
    const radarr = fakeServer({ add: mock(async () => 123) })
    const best = movie({ id: 'rel:best', tmdbId: 603, quality: { resolution: 1080 }, size: 100 })
    const worse = movie({ id: 'rel:worse', tmdbId: 603, quality: { resolution: 720 }, size: 999 })
    const peer = fakePeer({ searchByTmdbId: mock(async () => [worse, best]) })
    const downloads = fakeDownloads()
    const controller = new CatalogController(makeConnectors([radarr], [peer]) as any, undefined, downloads as any)

    const result = await controller.requestDownload({
      peerId: 'peer-1',
      serverId: 'radarr-1',
      mediaType: 'movie',
      tmdbId: 603,
      rootFolderPath: '/movies',
    })

    expect(result).toEqual({ ok: true, server: 'My Radarr', started: 1 })
    expect(radarr.add).toHaveBeenCalledWith({ tmdbId: 603, rootFolderPath: '/movies' })
    expect(downloads.startDirectDownload).toHaveBeenCalledWith({
      peerId: 'peer-1',
      itemId: 'rel:best',
      destinationServerName: 'My Radarr',
      destinationServerId: 'radarr-1',
      importTarget: { kind: 'movie', movieId: 123 },
    })
  })

  test('reports zero starts when a duplicate movie direct download is already active', async () => {
    const radarr = fakeServer({ add: mock(async () => 123) })
    const peer = fakePeer({ searchByTmdbId: mock(async () => [movie({ id: 'rel:1', tmdbId: 603, quality: { resolution: 1080 } })]) })
    const downloads = fakeDownloads({ startDirectDownload: mock(async (): Promise<StartQbDownloadResult> => 'duplicate') })
    const controller = new CatalogController(makeConnectors([radarr], [peer]), undefined, downloads)

    const result = await controller.requestDownload({
      peerId: 'peer-1',
      serverId: 'radarr-1',
      mediaType: 'movie',
      tmdbId: 603,
      rootFolderPath: '/movies',
    })

    expect(result).toEqual({ ok: true, server: 'My Radarr', started: 0 })
  })

  test('throws NotFoundError when the peer has no episodes for the tvdbId, and does not add', async () => {
    const sonarr = fakeServer({ id: 'sonarr-1', name: 'My Sonarr', type: 'sonarr', add: mock(async () => 55) })
    const peer = fakePeer({ searchByTvdbId: mock(async () => []) })
    const controller = new CatalogController(makeConnectors([sonarr], [peer]) as any, undefined, fakeDownloads() as any)

    await expect(controller.requestDownload({
      peerId: 'peer-1',
      serverId: 'sonarr-1',
      mediaType: 'tv',
      tvdbId: 81189,
      rootFolderPath: '/tv',
    })).rejects.toBeInstanceOf(NotFoundError)
    expect(sonarr.add).not.toHaveBeenCalled()
  })

  test('adds the series without search and starts a direct download for the best release per episode', async () => {
    const sonarr = fakeServer({ id: 'sonarr-1', name: 'My Sonarr', type: 'sonarr', add: mock(async () => 55) })
    const ep1a = episode({ id: 'ep:1a', tvdbId: 81189, season: 1, episode: 1, quality: { resolution: 720 }, size: 50 })
    const ep1b = episode({ id: 'ep:1b', tvdbId: 81189, season: 1, episode: 1, quality: { resolution: 1080 }, size: 60 })
    const ep2 = episode({ id: 'ep:2', tvdbId: 81189, season: 1, episode: 2, quality: { resolution: 720 }, size: 40 })
    const peer = fakePeer({ searchByTvdbId: mock(async () => [ep1a, ep1b, ep2]) })
    const downloads = fakeDownloads()
    const controller = new CatalogController(makeConnectors([sonarr], [peer]) as any, undefined, downloads as any)

    const result = await controller.requestDownload({
      peerId: 'peer-1',
      serverId: 'sonarr-1',
      mediaType: 'tv',
      tvdbId: 81189,
      rootFolderPath: '/tv',
    })

    expect(result).toEqual({ ok: true, server: 'My Sonarr', started: 2 })
    expect(sonarr.add).toHaveBeenCalledTimes(1)
    expect(sonarr.add).toHaveBeenCalledWith({ tvdbId: 81189, rootFolderPath: '/tv' })
    expect(downloads.startDirectDownload).toHaveBeenCalledTimes(2)
    expect(downloads.startDirectDownload).toHaveBeenCalledWith({
      peerId: 'peer-1',
      itemId: 'ep:1b',
      destinationServerName: 'My Sonarr',
      destinationServerId: 'sonarr-1',
      importTarget: { kind: 'series', seriesId: 55 },
    })
    expect(downloads.startDirectDownload).toHaveBeenCalledWith({
      peerId: 'peer-1',
      itemId: 'ep:2',
      destinationServerName: 'My Sonarr',
      destinationServerId: 'sonarr-1',
      importTarget: { kind: 'series', seriesId: 55 },
    })
  })

  test('throws BadRequestError when the movie direct download fails to start', async () => {
    const radarr = fakeServer({ add: mock(async () => 123) })
    const peer = fakePeer({ searchByTmdbId: mock(async () => [movie({ id: 'rel:1', tmdbId: 603, quality: { resolution: 1080 } })]) })
    const downloads = fakeDownloads({ startDirectDownload: mock(async (): Promise<StartQbDownloadResult> => 'failed') })
    const controller = new CatalogController(makeConnectors([radarr], [peer]) as any, undefined, downloads as any)

    await expect(controller.requestDownload({
      peerId: 'peer-1',
      serverId: 'radarr-1',
      mediaType: 'movie',
      tmdbId: 603,
      rootFolderPath: '/movies',
    })).rejects.toBeInstanceOf(BadRequestError)
  })

  test('throws BadRequestError when every episode direct download fails to start', async () => {
    const sonarr = fakeServer({ id: 'sonarr-1', name: 'My Sonarr', type: 'sonarr', add: mock(async () => 55) })
    const ep1 = episode({ id: 'ep:1', tvdbId: 81189, season: 1, episode: 1, quality: { resolution: 1080 }, size: 60 })
    const ep2 = episode({ id: 'ep:2', tvdbId: 81189, season: 1, episode: 2, quality: { resolution: 720 }, size: 40 })
    const peer = fakePeer({ searchByTvdbId: mock(async () => [ep1, ep2]) })
    const downloads = fakeDownloads({ startDirectDownload: mock(async (): Promise<StartQbDownloadResult> => 'failed') })
    const controller = new CatalogController(makeConnectors([sonarr], [peer]) as any, undefined, downloads as any)

    await expect(controller.requestDownload({
      peerId: 'peer-1',
      serverId: 'sonarr-1',
      mediaType: 'tv',
      tvdbId: 81189,
      rootFolderPath: '/tv',
    })).rejects.toBeInstanceOf(BadRequestError)
  })

  test('counts only non-failed episode starts when some fail', async () => {
    const sonarr = fakeServer({ id: 'sonarr-1', name: 'My Sonarr', type: 'sonarr', add: mock(async () => 55) })
    const ep1 = episode({ id: 'ep:1', tvdbId: 81189, season: 1, episode: 1, quality: { resolution: 1080 }, size: 60 })
    const ep2 = episode({ id: 'ep:2', tvdbId: 81189, season: 1, episode: 2, quality: { resolution: 720 }, size: 40 })
    const peer = fakePeer({ searchByTvdbId: mock(async () => [ep1, ep2]) })
    let calls = 0
    const downloads = fakeDownloads({ startDirectDownload: mock(async () => (calls++ === 0 ? 'started' : 'failed')) })
    const controller = new CatalogController(makeConnectors([sonarr], [peer]) as any, undefined, downloads as any)

    const result = await controller.requestDownload({
      peerId: 'peer-1',
      serverId: 'sonarr-1',
      mediaType: 'tv',
      tvdbId: 81189,
      rootFolderPath: '/tv',
    })

    expect(result).toEqual({ ok: true, server: 'My Sonarr', started: 1 })
  })

  test('counts only newly started episode downloads when duplicates and failures are mixed', async () => {
    const sonarr = fakeServer({ id: 'sonarr-1', name: 'My Sonarr', type: 'sonarr', add: mock(async () => 55) })
    const ep1 = episode({ id: 'ep:1', tvdbId: 81189, season: 1, episode: 1, quality: { resolution: 1080 }, size: 60 })
    const ep2 = episode({ id: 'ep:2', tvdbId: 81189, season: 1, episode: 2, quality: { resolution: 720 }, size: 40 })
    const ep3 = episode({ id: 'ep:3', tvdbId: 81189, season: 1, episode: 3, quality: { resolution: 720 }, size: 30 })
    const peer = fakePeer({ searchByTvdbId: mock(async () => [ep1, ep2, ep3]) })
    const outcomes = ['started', 'duplicate', 'failed'] as const
    let call = 0
    const downloads = fakeDownloads({ startDirectDownload: mock(async () => outcomes[call++] ?? 'failed') })
    const controller = new CatalogController(makeConnectors([sonarr], [peer]), undefined, downloads)

    const result = await controller.requestDownload({
      peerId: 'peer-1',
      serverId: 'sonarr-1',
      mediaType: 'tv',
      tvdbId: 81189,
      rootFolderPath: '/tv',
    })

    expect(result).toEqual({ ok: true, server: 'My Sonarr', started: 1 })
  })

  test('reports zero starts when every episode direct download is duplicate', async () => {
    const sonarr = fakeServer({ id: 'sonarr-1', name: 'My Sonarr', type: 'sonarr', add: mock(async () => 55) })
    const ep1 = episode({ id: 'ep:1', tvdbId: 81189, season: 1, episode: 1, quality: { resolution: 1080 }, size: 60 })
    const ep2 = episode({ id: 'ep:2', tvdbId: 81189, season: 1, episode: 2, quality: { resolution: 720 }, size: 40 })
    const peer = fakePeer({ searchByTvdbId: mock(async () => [ep1, ep2]) })
    const downloads = fakeDownloads({ startDirectDownload: mock(async (): Promise<StartQbDownloadResult> => 'duplicate') })
    const controller = new CatalogController(makeConnectors([sonarr], [peer]), undefined, downloads)

    const result = await controller.requestDownload({
      peerId: 'peer-1',
      serverId: 'sonarr-1',
      mediaType: 'tv',
      tvdbId: 81189,
      rootFolderPath: '/tv',
    })

    expect(result).toEqual({ ok: true, server: 'My Sonarr', started: 0 })
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
