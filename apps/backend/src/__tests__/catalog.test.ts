import type { PeerCatalogResponse, PeerCatalogTitle } from '../lib/peer-catalog'
import type { Release } from '../lib/release'
import type { TmdbMetadata } from '../lib/tmdb/client'
import type { DownloadsService, StartQbDownloadResult } from '../modules/downloads/downloads.service'
import { describe, expect, mock, test } from 'bun:test'
import { openMemoryDatabase } from '../database/connection'
import { BadRequestError } from '../lib/errors/BadRequestError'
import { NotFoundError } from '../lib/errors/NotFoundError'
import { CatalogCacheRepository } from '../modules/catalog/catalog-cache.repository'
import { CatalogSyncService } from '../modules/catalog/catalog-sync.service'
import { CatalogController } from '../modules/catalog/catalog.controller'
import { diffPeerCatalog, groupReleasesIntoUnifiedTitles, indexPeerTitles, pickBestPerEpisode, pickBestRelease, summarizeReleases } from '../modules/catalog/catalog.lib'
import { OwnCatalogRepository } from '../modules/catalog/own-catalog.repository'

function deferred<T>() {
  return Promise.withResolvers<T>()
}

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
      {
        peer: { id: 'p1', name: 'Alpha' },
        releases: [
          movie({ tmdbId: 603, size: 100 }),
        ],
      },
      {
        peer: { id: 'p2', name: 'Beta' },
        releases: [
          movie({ tmdbId: 603, size: 200 }),
        ],
      },
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

  test('summarizes each peer bucket with totals and distinct resolutions, best first', () => {
    const titles = groupReleasesIntoUnifiedTitles([
      {
        peer: { id: 'p1', name: 'Alpha' },
        releases: [
          episode({
            tvdbId: 1396,
            seriesTitle: 'Breaking Bad',
            season: 1,
            episode: 1,
            size: 50,
            quality: { resolution: 720 },
          }),
          episode({
            tvdbId: 1396,
            seriesTitle: 'Breaking Bad',
            season: 1,
            episode: 2,
            size: 60,
            quality: { resolution: 2160 },
          }),
          episode({
            tvdbId: 1396,
            seriesTitle: 'Breaking Bad',
            season: 1,
            episode: 3,
            size: 70,
            quality: { resolution: 720 },
          }),
          episode({
            tvdbId: 1396,
            seriesTitle: 'Breaking Bad',
            season: 1,
            episode: 4,
            size: 80,
          }),
        ],
      },
    ])

    expect(titles).toHaveLength(1)
    expect(titles[0]!.peers[0]).toEqual({
      id: 'p1',
      name: 'Alpha',
      releaseCount: 4,
      totalSize: 260,
      resolutions: [2160, 720],
    })
  })

  test('collapses an id-less release on one peer into the strong-id bucket from another peer', () => {
    const titles = groupReleasesIntoUnifiedTitles([
      {
        peer: { id: 'p1', name: 'Alpha' },
        releases: [
          episode({ seriesTitle: 'Some Show', size: 50 }),
        ],
      },
      {
        peer: { id: 'p2', name: 'Beta' },
        releases: [
          episode({ seriesTitle: 'Some Show', tvdbId: 999, size: 60 }),
        ],
      },
    ])

    expect(titles).toHaveLength(1)
    expect(titles[0]!.tvdbId).toBe(999)
    expect(titles[0]!.key).toContain('id:999')
    expect(titles[0]!.peers.map(p => p.id).sort()).toEqual(['p1', 'p2'])
  })

  test('does not alias id-less same-name releases when strong ids are ambiguous', () => {
    const titles = groupReleasesIntoUnifiedTitles([
      {
        peer: { id: 'p1', name: 'Alpha' },
        releases: [
          movie({ title: 'The Thing', tmdbId: 1091 }),
        ],
      },
      {
        peer: { id: 'p2', name: 'Beta' },
        releases: [
          movie({ title: 'The Thing', tmdbId: 609 }),
        ],
      },
      {
        peer: { id: 'p3', name: 'Gamma' },
        releases: [
          movie({ title: 'The Thing' }),
        ],
      },
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
      {
        peer: { id: 'p1', name: 'Alpha' },
        releases: [
          movie({ title: 'Zebra', tmdbId: 1 }),
          movie({ title: 'Apple', tmdbId: 2 }),
        ],
      },
    ])

    expect(titles.map(t => t.displayTitle)).toEqual(['Apple', 'Zebra'])
  })
})

describe('diffPeerCatalog', () => {
  const base: PeerCatalogTitle = {
    mediaType: 'movie',
    tmdbId: 603,
    title: 'The Matrix',
    releaseCount: 1,
    totalSize: 100,
    resolutions: [1080],
  }

  test('separates added, updated, removed and unchanged titles', () => {
    const cached = indexPeerTitles([
      base,
      { ...base, tmdbId: 604, title: 'Reloaded' },
      { ...base, tmdbId: 605, title: 'Revolutions' },
    ])
    const fresh = indexPeerTitles([
      base,
      // Quality upgrade: same title, new resolution.
      {
        ...base,
        tmdbId: 604,
        title: 'Reloaded',
        resolutions: [2160, 1080],
      },
      { ...base, tmdbId: 606, title: 'Resurrections' },
    ])

    const diff = diffPeerCatalog(cached, fresh)

    expect([
      ...diff.added.keys(),
    ]).toEqual(['movie:id:606'])
    expect([
      ...diff.updated.keys(),
    ]).toEqual(['movie:id:604'])
    expect(diff.removed).toEqual(['movie:id:605'])
  })

  test('merges duplicate entries for the same title from one peer', () => {
    const indexed = indexPeerTitles([
      base,
      {
        ...base,
        releaseCount: 2,
        totalSize: 300,
        resolutions: [720, 2160],
      },
    ])

    expect([
      ...indexed.values(),
    ]).toEqual([
      {
        ...base,
        releaseCount: 3,
        totalSize: 400,
        resolutions: [2160, 1080, 720],
      },
    ])
  })
})

describe('catalogCacheRepository.applyPeerCatalog', () => {
  test('writes only the rows that changed', async () => {
    const cache = new CatalogCacheRepository(openMemoryDatabase())
    const first = summarizeReleases([
      movie({
        tmdbId: 603,
        quality: { resolution: 1080 },
      }),
      movie({
        tmdbId: 604,
        quality: { resolution: 1080 },
      }),
    ])
    cache.applyPeerCatalog('p1', indexPeerTitles(first))

    const second = summarizeReleases([
      movie({
        tmdbId: 603,
        quality: { resolution: 1080 },
      }),
      movie({
        tmdbId: 604,
        quality: { resolution: 2160 },
      }),
      movie({ tmdbId: 605 }),
    ])
    const diff = cache.applyPeerCatalog('p1', indexPeerTitles(second))

    expect(diff.added.size).toBe(1)
    expect(diff.updated.size).toBe(1)
    expect(diff.removed).toEqual([])
    const stored = cache.listByPeer(['p1']).get('p1')!
    expect(stored.find(t => t.tmdbId === 604)!.resolutions).toEqual([2160])
    expect(stored).toHaveLength(3)
  })

  test('removes titles the peer no longer carries, leaving other peers alone', () => {
    const cache = new CatalogCacheRepository(openMemoryDatabase())
    cache.applyPeerCatalog('p1', indexPeerTitles(summarizeReleases([
      movie({ tmdbId: 603 }),
    ])))
    cache.applyPeerCatalog('p2', indexPeerTitles(summarizeReleases([
      movie({ tmdbId: 603 }),
    ])))

    cache.applyPeerCatalog('p1', new Map())

    expect([
      ...cache.listByPeer(['p1', 'p2']).keys(),
    ]).toEqual(['p2'])
  })
})

describe('pickBestRelease', () => {
  test('returns undefined for an empty list', () => {
    expect(pickBestRelease([])).toBeUndefined()
  })

  test('prefers the higher resolution even when a lower one has a larger file', () => {
    const sd = movie({
      id: 'a',
      quality: { resolution: 720 },
      size: 999,
    })
    const hd = movie({
      id: 'b',
      quality: { resolution: 1080 },
      size: 1,
    })
    expect(pickBestRelease([sd, hd])).toBe(hd)
  })

  test('breaks a resolution tie by the larger file', () => {
    const small = movie({
      id: 'a',
      quality: { resolution: 1080 },
      size: 10,
    })
    const big = movie({
      id: 'b',
      quality: { resolution: 1080 },
      size: 20,
    })
    expect(pickBestRelease([small, big])).toBe(big)
  })

  test('breaks a full tie deterministically by the lowest release id, regardless of input order', () => {
    const z = movie({
      id: 'zzz',
      quality: { resolution: 1080 },
      size: 10,
    })
    const a = movie({
      id: 'aaa',
      quality: { resolution: 1080 },
      size: 10,
    })
    expect(pickBestRelease([z, a])).toBe(a)
    expect(pickBestRelease([a, z])).toBe(a)
  })
})

describe('pickBestPerEpisode', () => {
  test('keeps the best release per season/episode key', () => {
    const s1e1Sd = episode({
      id: 'a',
      season: 1,
      episode: 1,
      quality: { resolution: 720 },
    })
    const s1e1Hd = episode({
      id: 'b',
      season: 1,
      episode: 1,
      quality: { resolution: 1080 },
    })
    const s1e2 = episode({
      id: 'c',
      season: 1,
      episode: 2,
      quality: { resolution: 720 },
    })
    const best = pickBestPerEpisode([s1e1Sd, s1e1Hd, s1e2])
    expect(best).toHaveLength(2)
    expect(best).toContain(s1e1Hd)
    expect(best).toContain(s1e2)
    expect(best).not.toContain(s1e1Sd)
  })

  test('keeps unnumbered episode releases separate instead of collapsing them to one slot', () => {
    const first = episode({
      id: 'unparsed:1',
      tvdbId: 81189,
      title: 'Show.Special.A',
      filename: 'Show.Special.A.mkv',
      quality: { resolution: 720 },
    })
    const second = episode({
      id: 'unparsed:2',
      tvdbId: 81189,
      title: 'Show.Special.B',
      filename: 'Show.Special.B.mkv',
      quality: { resolution: 1080 },
    })

    const best = pickBestPerEpisode([first, second])

    expect(best).toHaveLength(2)
    expect(best).toContain(first)
    expect(best).toContain(second)
  })
})

describe('catalogSyncService', () => {
  // A pre-0.2.0 peer: no /peer/catalog, so it hands back full releases.
  function legacyPeer(id: string, name: string, releases: () => Promise<Release[]>, isInitialized = true) {
    return {
      id,
      name,
      isInitialized,
      listCatalog: mock(async (_since?: Since) => ({ kind: 'releases' as const, releases: await releases() })),
    }
  }

  type Since = { revision: number, generation?: string } | undefined

  // A 0.2.0+ peer serving per-title changes since a revision.
  function summaryPeer(id: string, name: string, respond: (since: Since) => Omit<PeerCatalogResponse, 'generation'>) {
    return {
      id,
      name,
      isInitialized: true,
      listCatalog: mock(async (since?: Since) => ({
        kind: 'titles' as const,
        generation: 'g1',
        ...respond(since),
      })),
    }
  }

  // A source Radarr: `titles()` is what it carries now.
  function sourceRadarr(titles: () => PeerCatalogTitle[], id = 'radarr') {
    return {
      id,
      canSource: true,
      isInitialized: true,
      name: id,
      listCatalog: mock(async (only?: { tmdbId?: number }) => titles()
        .filter(t => !only || t.tmdbId === only.tmdbId)
        .map(title => ({
          title,
          releases: [
            movie({ id: `${id}:movie:${title.tmdbId}`, tmdbId: title.tmdbId }),
          ],
        }))),
      listLibrary: async () => [],
    }
  }

  function setup(connectors: { servers?: any[], peers?: any[] }, metadata?: { get: (mediaType: string, tmdbId: number) => TmdbMetadata | null | undefined }) {
    const db = openMemoryDatabase()
    const peerCache = new CatalogCacheRepository(db)
    const own = new OwnCatalogRepository(db)
    const live = { servers: connectors.servers ?? [], peers: connectors.peers ?? [] }
    const sync = new CatalogSyncService({
      connectors: live as any,
      own,
      peerCache,
      metadata,
      schedule: () => '0 * * * *',
    })
    const controller = new CatalogController(live as any, undefined, undefined, { catalog: peerCache, sync })
    return {
      sync,
      own,
      peerCache,
      controller,
      live,
    }
  }

  const matrix: PeerCatalogTitle = {
    mediaType: 'movie',
    tmdbId: 603,
    title: 'The Matrix',
    releaseCount: 1,
    totalSize: 100,
    resolutions: [1080],
  }

  test('caches every peer so the catalog is served without contacting them', async () => {
    const p1 = legacyPeer('p1', 'Alpha', async () => [
      movie({ tmdbId: 603, size: 100 }),
    ])
    const p2 = legacyPeer('p2', 'Beta', async () => [
      movie({ tmdbId: 603, size: 200 }),
    ])
    const { sync, controller } = setup({
      peers: [p1, p2],
    })
    await sync.sync()

    const result = controller.getCatalog()

    expect(result.peers).toEqual([
      { id: 'p1', name: 'Alpha' },
      { id: 'p2', name: 'Beta' },
    ])
    expect(result.titles).toHaveLength(1)
    expect(result.titles[0]!.releaseCount).toBe(2)
    expect(result.sync.syncedAt).not.toBeNull()
    expect(p1.listCatalog).toHaveBeenCalledTimes(1)
  })

  test('asks a 0.2.0+ peer for changes since the revision it last applied', async () => {
    const peer = summaryPeer('p1', 'New', since => since === undefined
      ? {
          revision: 3,
          full: true,
          titles: [
            matrix,
            { ...matrix, tmdbId: 604, title: 'Reloaded' },
          ],
          removed: [],
        }
      : {
          revision: 5,
          full: false,
          titles: [
            {
              ...matrix,
              resolutions: [2160, 1080],
            },
          ],
          removed: ['movie:id:604'],
        })
    const { sync, controller } = setup({
      peers: [peer],
    })

    await sync.sync()
    await sync.sync()

    expect(peer.listCatalog.mock.calls.map(call => call[0])).toEqual([
      undefined,
      { revision: 3, generation: 'g1' },
    ])
    const { titles } = controller.getCatalog()
    expect(titles.map(t => [t.displayTitle, t.peers[0]!.resolutions])).toEqual([
      [
        'The Matrix',
        [2160, 1080],
      ],
    ])
  })

  test('a full response replaces everything cached for that peer', async () => {
    let round = 0
    const peer = summaryPeer('p1', 'New', () => round++ === 0
      ? {
          revision: 1,
          full: true,
          titles: [
            matrix,
            { ...matrix, tmdbId: 604, title: 'Reloaded' },
          ],
          removed: [],
        }
      : {
          revision: 1,
          full: true,
          titles: [matrix],
          removed: [],
        })
    const { sync, controller } = setup({
      peers: [peer],
    })

    await sync.sync()
    await sync.sync()

    expect(controller.getCatalog().titles.map(t => t.displayTitle)).toEqual(['The Matrix'])
  })

  test('keeps the cached titles of a peer that fails', async () => {
    let fail = false
    const flaky = legacyPeer('p1', 'Flaky', async () => {
      if (fail)
        throw new Error('unreachable')
      return [
        movie({ tmdbId: 603 }),
      ]
    })
    const { sync, controller } = setup({
      peers: [flaky],
    })
    await sync.sync()

    fail = true
    await sync.sync()
    expect(controller.getCatalog().titles).toHaveLength(1)
  })

  test('asks a peer that was offline at boot, so it shows up once it\'s back', async () => {
    // isInitialized false: the handshake failed at boot. listCatalog retries it.
    const peer = legacyPeer('p1', 'Late', async () => [
      movie({ tmdbId: 603 }),
    ], false)
    const { sync, controller } = setup({
      peers: [peer],
    })

    await sync.sync()

    expect(peer.listCatalog).toHaveBeenCalledTimes(1)
    expect(controller.getCatalog().titles).toHaveLength(1)
  })

  test('drops a peer from the cache once it is no longer configured', async () => {
    const { sync, controller, peerCache, live } = setup({
      peers: [
        legacyPeer('p1', 'Alpha', async () => [
          movie({ tmdbId: 603 }),
        ]),
        legacyPeer('p2', 'Beta', async () => [
          movie({ tmdbId: 604 }),
        ]),
      ],
    })
    await sync.sync()

    live.peers = live.peers.filter(p => p.id === 'p1')
    expect(controller.getCatalog().peers).toEqual([
      { id: 'p1', name: 'Alpha' },
    ])
    await sync.sync()
    expect([
      ...peerCache.listByPeer(['p1', 'p2']).keys(),
    ]).toEqual(['p1'])
  })

  test('joins a sync that is already running', async () => {
    const releases = deferred<Release[]>()
    const slow = legacyPeer('p1', 'Slow', () => releases.promise)
    const { sync } = setup({
      peers: [slow],
    })

    const first = sync.sync()
    const second = sync.sync()
    expect(sync.status.syncing).toBe(true)
    releases.resolve([])
    await Promise.all([first, second])

    expect(slow.listCatalog).toHaveBeenCalledTimes(1)
    expect(sync.status.syncing).toBe(false)
  })

  test('caches old peers\' movies under their stored TMDB title', async () => {
    const peer = legacyPeer('p1', 'Alpha', async () => [
      movie({ tmdbId: 603, title: 'The.Matrix.1999.2160p', movieTitle: 'The Matrix' }),
      movie({ tmdbId: 604, title: 'The.Matrix.Reloaded.2003.1080p' }),
      movie({ tmdbId: 605, title: 'The.Matrix.Revolutions.2003.1080p' }),
    ])
    const reloaded = {
      tmdbId: 604,
      title: 'The Matrix Reloaded',
      overview: null,
      year: 2003,
      rating: null,
      posterUrl: null,
      backdropUrl: null,
      genres: [],
    }
    const { sync, controller } = setup({
      peers: [peer],
    }, {
      get: (_, tmdbId) => tmdbId === 604
        ? reloaded
        : undefined,
    })
    await sync.sync()

    expect(controller.getCatalog().titles.map(t => t.displayTitle)).toEqual([
      'The Matrix',
      'The Matrix Reloaded',
      'The.Matrix.Revolutions.2003.1080p',
    ])
  })

  test('rebuilds the own catalog from the sources, with one revision per change', async () => {
    let resolutions = [1080]
    const radarr = sourceRadarr(() => [
      { ...matrix, resolutions },
    ])
    const { sync, own } = setup({
      servers: [radarr],
    })

    await sync.sync()
    const generation = own.generation()
    expect(own.searchReleases(['radarr'], { tmdbId: '603' })).toHaveLength(1)
    expect(own.changesSince(['radarr'])).toEqual({
      revision: 1,
      generation,
      full: true,
      titles: [matrix],
      removed: [],
    })

    // Nothing changed: no new revision.
    await sync.sync()
    expect(own.currentRevision()).toBe(1)

    resolutions = [2160, 1080]
    await sync.sync()
    expect(own.changesSince(['radarr'], 1, generation)).toEqual({
      revision: 2,
      generation,
      full: false,
      titles: [
        {
          ...matrix,
          resolutions: [2160, 1080],
        },
      ],
      removed: [],
    })
  })

  test('addImported marks the title owned and adds just it to the own catalog', async () => {
    const reloaded: PeerCatalogTitle = { ...matrix, tmdbId: 604, title: 'The Matrix Reloaded' }
    let library: PeerCatalogTitle[] = [matrix]
    const radarr = sourceRadarr(() => library)
    const peer = legacyPeer('p1', 'Alpha', async () => [
      movie({ tmdbId: 604, title: 'Reloaded' }),
    ])
    const { sync, own, controller } = setup({
      servers: [radarr],
      peers: [peer],
    })
    await sync.sync()
    expect(controller.getCatalog().titles[0]!.inLibrary).toBe(false)

    library = [matrix, reloaded]
    await sync.addImported(movie({ tmdbId: 604 }))

    expect(controller.getCatalog().titles[0]!.inLibrary).toBe(true)
    expect(radarr.listCatalog).toHaveBeenLastCalledWith({ tmdbId: 604 })
    expect(own.searchReleases(['radarr'], { tmdbId: '604' })!.map(r => r.id)).toEqual(['radarr:movie:604'])
    expect(own.changesSince(['radarr'], 1, own.generation())).toMatchObject({
      revision: 2,
      full: false,
      titles: [reloaded],
      removed: [],
    })
  })

  test('an import never gets undone by a sync that read the sources before it', async () => {
    const reloaded: PeerCatalogTitle = { ...matrix, tmdbId: 604, title: 'The Matrix Reloaded' }
    let library: PeerCatalogTitle[] = [matrix]
    const gate = deferred<void>()
    const radarr = sourceRadarr(() => library)
    const firstRead = radarr.listCatalog.getMockImplementation()!
    // The full sync reads the old library, then stalls before writing.
    radarr.listCatalog.mockImplementationOnce(async (only?: { tmdbId?: number }) => {
      const result = await firstRead(only)
      await gate.promise
      return result
    })
    const { sync, own } = setup({
      servers: [radarr],
    })

    const syncing = sync.sync()
    library = [matrix, reloaded]
    const importing = sync.addImported(movie({ tmdbId: 604 }))
    gate.resolve()
    await Promise.all([syncing, importing])

    expect(own.changesSince(['radarr']).titles.map(t => t.tmdbId)).toEqual([603, 604])
  })

  test('keeps the titles of a source that fails, and only that source\'s', async () => {
    let fail = false
    const radarr = sourceRadarr(() => {
      if (fail)
        throw new Error('down')
      return [matrix]
    }, 'radarr')
    let hd: PeerCatalogTitle[] = [
      { ...matrix, tmdbId: 604, title: 'Reloaded' },
    ]
    const radarrHd = sourceRadarr(() => hd, 'radarr-hd')
    const { sync, own } = setup({
      servers: [radarr, radarrHd],
    })
    await sync.sync()

    fail = true
    hd = []
    await sync.sync()

    expect(own.changesSince(['radarr', 'radarr-hd']).titles.map(t => t.tmdbId)).toEqual([603])
  })

  test('drops a source that is no longer a source', async () => {
    const radarr = sourceRadarr(() => [matrix])
    const { sync, own, live } = setup({
      servers: [radarr],
    })
    await sync.sync()

    live.servers = []
    await sync.sync()

    expect(own.changesSince([]).titles).toEqual([])
    expect(own.searchReleases(['radarr'], {})).toEqual([])
  })

  test('an emptied catalog is still answered from the cache', async () => {
    let titles: PeerCatalogTitle[] = [matrix]
    const radarr = sourceRadarr(() => titles)
    const { sync, own } = setup({
      servers: [radarr],
    })
    await sync.sync()

    titles = []
    await sync.sync()

    // Read and empty, which is not the same as never read (null).
    expect(own.searchReleases(['radarr'], { tmdbId: '603' })).toEqual([])
  })

  test('keeps an import\'s owned mark while a library can\'t be read', async () => {
    const peer = legacyPeer('p1', 'Alpha', async () => [
      movie({ tmdbId: 604, title: 'Reloaded' }),
    ])
    let fail = false
    const radarr = {
      id: 'radarr',
      isInitialized: true,
      listLibrary: async () => {
        if (fail)
          throw new Error('down')
        return []
      },
    }
    const { sync, controller } = setup({
      servers: [radarr],
      peers: [peer],
    })
    await sync.sync()

    await sync.addImported(movie({ tmdbId: 604 }))
    fail = true
    await sync.sync()

    expect(controller.getCatalog().titles[0]!.inLibrary).toBe(true)
  })

  test('marks titles the local library already has', async () => {
    const peer = legacyPeer('p1', 'Alpha', async () => [
      movie({ tmdbId: 603, title: 'The Matrix' }),
      movie({ imdbId: '0133093', title: 'Matrix by imdb' }),
      movie({ tmdbId: 604, title: 'Reloaded' }),
      episode({ tvdbId: 1396, seriesTitle: 'Breaking Bad' }),
      episode({ tvdbId: 9999, seriesTitle: 'Other Show' }),
    ])
    const radarr = {
      id: 'radarr',
      isInitialized: true,
      listLibrary: async () => [
        { mediaType: 'movie', tmdbId: 603, imdbId: 'tt0133093' },
      ],
    }
    const sonarr = {
      id: 'sonarr',
      isInitialized: true,
      listLibrary: async () => [
        { mediaType: 'tv', tvdbId: 1396 },
        // Same numeric id as a movie title must not cross media types.
        { mediaType: 'tv', tmdbId: 604 },
      ],
    }
    const { sync, controller } = setup({
      servers: [radarr, sonarr],
      peers: [peer],
    })
    await sync.sync()

    const owned = Object.fromEntries(controller.getCatalog().titles.map(t => [t.displayTitle, t.inLibrary]))

    expect(owned).toEqual({
      'The Matrix': true,
      'Matrix by imdb': true,
      'Reloaded': false,
      'Breaking Bad': true,
      'Other Show': false,
    })
  })

  test('attaches stored TMDB metadata, including known misses', async () => {
    const peer = legacyPeer('p1', 'Alpha', async () => [
      movie({ tmdbId: 603, title: 'Matrix' }),
      movie({ tmdbId: 604, title: 'Missing' }),
      movie({ tmdbId: 605, title: 'Unknown' }),
    ])
    const matrixMeta = {
      tmdbId: 603,
      title: 'The Matrix',
      overview: null,
      year: 1999,
      rating: 8,
      posterUrl: null,
      backdropUrl: null,
      genres: ['Action'],
    }
    const stored = new Map<string, TmdbMetadata | null>([
      ['movie:603', matrixMeta],
      ['movie:604', null],
    ])
    const db = openMemoryDatabase()
    const peerCache = new CatalogCacheRepository(db)
    const live = {
      servers: [],
      peers: [peer],
    }
    const sync = new CatalogSyncService({
      connectors: live as any,
      own: new OwnCatalogRepository(db),
      peerCache,
      schedule: () => '0 * * * *',
    })
    const controller = new CatalogController(live as any, undefined, undefined, {
      catalog: peerCache,
      sync,
      metadata: {
        all: () => stored,
      },
    })
    await sync.sync()

    const byId = Object.fromEntries(controller.getCatalog().titles.map(t => [t.tmdbId, t]))

    expect(byId[603]!.metadata).toEqual(matrixMeta)
    expect(byId[603]!.genres).toEqual(['Action'])
    expect(byId[604]!.metadata).toBeNull()
    expect('metadata' in byId[605]!).toBe(false)
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
      getRootFolders: async () => [
        { path: '/movies', freeSpace: 1000 },
      ],
      ...overrides,
    }
  }

  function makeConnectors(servers: any[]) {
    return { servers, peers: [] }
  }

  test('returns only initialized destinations and tags movies with mediaType "movie"', async () => {
    const radarr = fakeServer({ id: 'radarr-1', name: 'My Radarr', type: 'radarr' })
    const sonarrSourceOnly = fakeServer({
      id: 'sonarr-1',
      name: 'Source Sonarr',
      type: 'sonarr',
      canDestination: false,
    })
    const controller = new CatalogController(makeConnectors([radarr, sonarrSourceOnly]) as any)

    const options = await controller.getRequestOptions()

    expect(options).toHaveLength(1)
    expect(options[0]!.id).toBe('radarr-1')
    expect(options[0]!.name).toBe('My Radarr')
    expect(options[0]!.type).toBe('radarr')
    expect(options[0]!.mediaType).toBe('movie')
    expect(options[0]!).not.toHaveProperty('qualityProfiles')
    expect(options[0]!.rootFolders).toEqual([
      { path: '/movies', freeSpace: 1000 },
    ])
  })

  test('tags a destination Sonarr with mediaType "tv"', async () => {
    const sonarr = fakeServer({
      id: 'sonarr-1',
      name: 'My Sonarr',
      type: 'sonarr',
      getRootFolders: async () => [
        { path: '/tv' },
      ],
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
      searchByTmdbId: overrides.searchByTmdbId ?? mock(async () => [
        movie({
          id: 'rel:1',
          tmdbId: 603,
          quality: { resolution: 1080 },
        }),
      ]),
      searchByTvdbId: overrides.searchByTvdbId ?? mock(async () => [
        episode({
          id: 'ep:1',
          tvdbId: 81189,
          season: 1,
          episode: 1,
          quality: { resolution: 1080 },
        }),
      ]),
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
    const controller = new CatalogController(makeConnectors([radarr], [
      fakePeer(),
    ]) as any)

    expect(controller.requestDownload({
      peerId: 'peer-1',
      serverId: 'radarr-1',
      mediaType: 'movie',
      tmdbId: 603,
      rootFolderPath: '/movies',
    })).rejects.toBeInstanceOf(BadRequestError)
  })

  test('throws NotFoundError for an unknown serverId', () => {
    const controller = new CatalogController(makeConnectors([], [
      fakePeer(),
    ]) as any, undefined, fakeDownloads() as any)

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
    const controller = new CatalogController(makeConnectors([radarr], [
      fakePeer(),
    ]) as any, undefined, fakeDownloads() as any)

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
    const controller = new CatalogController(makeConnectors([sonarr], [
      fakePeer(),
    ]) as any, undefined, fakeDownloads() as any)

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
    const controller = new CatalogController(makeConnectors([sonarr], [
      fakePeer(),
    ]) as any, undefined, fakeDownloads() as any)

    expect(controller.requestDownload({
      peerId: 'peer-1',
      serverId: 'sonarr-1',
      mediaType: 'tv',
      rootFolderPath: '/tv',
    })).rejects.toBeInstanceOf(BadRequestError)
  })

  test('throws NotFoundError when the peer has no release for the tmdbId, and does not add', async () => {
    const radarr = fakeServer()
    const peer = fakePeer({
      searchByTmdbId: mock(async () => []),
    })
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
    const radarr = fakeServer({
      add: mock(async () => 123),
    })
    const best = movie({
      id: 'rel:best',
      tmdbId: 603,
      quality: { resolution: 1080 },
      size: 100,
    })
    const worse = movie({
      id: 'rel:worse',
      tmdbId: 603,
      quality: { resolution: 720 },
      size: 999,
    })
    const peer = fakePeer({
      searchByTmdbId: mock(async () => [worse, best]),
    })
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
    const radarr = fakeServer({
      add: mock(async () => 123),
    })
    const peer = fakePeer({
      searchByTmdbId: mock(async () => [
        movie({
          id: 'rel:1',
          tmdbId: 603,
          quality: { resolution: 1080 },
        }),
      ]),
    })
    const downloads = fakeDownloads({
      startDirectDownload: mock(async (): Promise<StartQbDownloadResult> => 'duplicate'),
    })
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
    const sonarr = fakeServer({
      id: 'sonarr-1',
      name: 'My Sonarr',
      type: 'sonarr',
      add: mock(async () => 55),
    })
    const peer = fakePeer({
      searchByTvdbId: mock(async () => []),
    })
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
    const sonarr = fakeServer({
      id: 'sonarr-1',
      name: 'My Sonarr',
      type: 'sonarr',
      add: mock(async () => 55),
    })
    const ep1a = episode({
      id: 'ep:1a',
      tvdbId: 81189,
      season: 1,
      episode: 1,
      quality: { resolution: 720 },
      size: 50,
    })
    const ep1b = episode({
      id: 'ep:1b',
      tvdbId: 81189,
      season: 1,
      episode: 1,
      quality: { resolution: 1080 },
      size: 60,
    })
    const ep2 = episode({
      id: 'ep:2',
      tvdbId: 81189,
      season: 1,
      episode: 2,
      quality: { resolution: 720 },
      size: 40,
    })
    const peer = fakePeer({
      searchByTvdbId: mock(async () => [ep1a, ep1b, ep2]),
    })
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
    const radarr = fakeServer({
      add: mock(async () => 123),
    })
    const peer = fakePeer({
      searchByTmdbId: mock(async () => [
        movie({
          id: 'rel:1',
          tmdbId: 603,
          quality: { resolution: 1080 },
        }),
      ]),
    })
    const downloads = fakeDownloads({
      startDirectDownload: mock(async (): Promise<StartQbDownloadResult> => 'failed'),
    })
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
    const sonarr = fakeServer({
      id: 'sonarr-1',
      name: 'My Sonarr',
      type: 'sonarr',
      add: mock(async () => 55),
    })
    const ep1 = episode({
      id: 'ep:1',
      tvdbId: 81189,
      season: 1,
      episode: 1,
      quality: { resolution: 1080 },
      size: 60,
    })
    const ep2 = episode({
      id: 'ep:2',
      tvdbId: 81189,
      season: 1,
      episode: 2,
      quality: { resolution: 720 },
      size: 40,
    })
    const peer = fakePeer({
      searchByTvdbId: mock(async () => [ep1, ep2]),
    })
    const downloads = fakeDownloads({
      startDirectDownload: mock(async (): Promise<StartQbDownloadResult> => 'failed'),
    })
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
    const sonarr = fakeServer({
      id: 'sonarr-1',
      name: 'My Sonarr',
      type: 'sonarr',
      add: mock(async () => 55),
    })
    const ep1 = episode({
      id: 'ep:1',
      tvdbId: 81189,
      season: 1,
      episode: 1,
      quality: { resolution: 1080 },
      size: 60,
    })
    const ep2 = episode({
      id: 'ep:2',
      tvdbId: 81189,
      season: 1,
      episode: 2,
      quality: { resolution: 720 },
      size: 40,
    })
    const peer = fakePeer({
      searchByTvdbId: mock(async () => [ep1, ep2]),
    })
    let calls = 0
    const downloads = fakeDownloads({
      startDirectDownload: mock(async () => (calls++ === 0
        ? 'started'
        : 'failed')),
    })
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
    const sonarr = fakeServer({
      id: 'sonarr-1',
      name: 'My Sonarr',
      type: 'sonarr',
      add: mock(async () => 55),
    })
    const ep1 = episode({
      id: 'ep:1',
      tvdbId: 81189,
      season: 1,
      episode: 1,
      quality: { resolution: 1080 },
      size: 60,
    })
    const ep2 = episode({
      id: 'ep:2',
      tvdbId: 81189,
      season: 1,
      episode: 2,
      quality: { resolution: 720 },
      size: 40,
    })
    const ep3 = episode({
      id: 'ep:3',
      tvdbId: 81189,
      season: 1,
      episode: 3,
      quality: { resolution: 720 },
      size: 30,
    })
    const peer = fakePeer({
      searchByTvdbId: mock(async () => [ep1, ep2, ep3]),
    })
    const outcomes = ['started', 'duplicate', 'failed'] as const
    let call = 0
    const downloads = fakeDownloads({
      startDirectDownload: mock(async () => outcomes[call++] ?? 'failed'),
    })
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
    const sonarr = fakeServer({
      id: 'sonarr-1',
      name: 'My Sonarr',
      type: 'sonarr',
      add: mock(async () => 55),
    })
    const ep1 = episode({
      id: 'ep:1',
      tvdbId: 81189,
      season: 1,
      episode: 1,
      quality: { resolution: 1080 },
      size: 60,
    })
    const ep2 = episode({
      id: 'ep:2',
      tvdbId: 81189,
      season: 1,
      episode: 2,
      quality: { resolution: 720 },
      size: 40,
    })
    const peer = fakePeer({
      searchByTvdbId: mock(async () => [ep1, ep2]),
    })
    const downloads = fakeDownloads({
      startDirectDownload: mock(async (): Promise<StartQbDownloadResult> => 'duplicate'),
    })
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
    const tmdb = {
      ping: async () => true,
    }
    const controller = new CatalogController(makeConnectors() as any, tmdb as any)

    expect(await controller.getTmdbStatus()).toEqual({ configured: true, ok: true })
  })

  test('reports configured but not ok when the client ping resolves false', async () => {
    const tmdb = {
      ping: async () => false,
    }
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
