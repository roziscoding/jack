import type { CatalogController } from '../modules/catalog/catalog.controller'
import type { UnifiedCatalogTitle } from '../modules/catalog/catalog.lib'
import type { CatalogQuery } from '../modules/catalog/catalog.query'
import { describe, expect, test } from 'bun:test'
import { sortTitle } from '../lib/sort-title'
import { titleSearchScore } from '../lib/title-search'
import { queryCatalog } from '../modules/catalog/catalog.query'
import { getCatalogRouter } from '../modules/catalog/catalog.router'

const ALL: CatalogQuery = {
  type: 'all',
  peers: [],
  genres: [],
  hideOwned: false,
}

function title(displayTitle: string, overrides: Partial<UnifiedCatalogTitle> = {}): UnifiedCatalogTitle {
  return {
    key: displayTitle,
    mediaType: 'movie',
    displayTitle,
    genres: [],
    releaseCount: 1,
    totalSize: 1,
    inLibrary: false,
    peers: [
      {
        id: 'p1',
        name: 'Alpha',
        releaseCount: 1,
        totalSize: 1,
        resolutions: [],
      },
    ],
    ...overrides,
  }
}

const names = (titles: UnifiedCatalogTitle[]) => titles.map(t => t.displayTitle)

describe('titleSearchScore', () => {
  test('matches the start of words only', () => {
    expect(titleSearchScore('Wild.Tales.2014.1080p.BluRay.REMUX-EPSiLON', 'silo')).toBeNull()
    expect(titleSearchScore('Silo', 'sil')).not.toBeNull()
  })

  test('ranks an exact name above a prefix above a match elsewhere', () => {
    expect(titleSearchScore('Silo', 'silo')).toBe(0)
    expect(titleSearchScore('Silo: Origins', 'SILO')).toBe(1)
    expect(titleSearchScore('The Silo Files', 'silo')).toBe(2)
  })

  test('matches words in any order, ignoring accents', () => {
    expect(titleSearchScore('The Matrix Reloaded', 'reloaded matrix')).toBe(2)
    expect(titleSearchScore('Amélie', 'amelie')).toBe(0)
    expect(titleSearchScore('The Matrix Reloaded', 'matrix sintel')).toBeNull()
  })
})

describe('sortTitle', () => {
  test('drops a leading article, like Radarr and Sonarr', () => {
    expect(sortTitle('The Matrix')).toBe('matrix')
    expect(sortTitle('A Quiet Place')).toBe('quiet place')
    expect(sortTitle('An American Werewolf in London')).toBe('american werewolf in london')
  })

  test('keeps an article that is not a separate leading word', () => {
    expect(sortTitle('Theodore Rex')).toBe('theodore rex')
    expect(sortTitle('Into the Wild')).toBe('into the wild')
  })

  test('removes punctuation without adding spaces', () => {
    expect(sortTitle('Silo: Origins')).toBe('silo origins')
    expect(sortTitle('Spider-Man')).toBe('spiderman')
  })

  test('uses the ids the *arrs pin', () => {
    expect(sortTitle('A to Z', { mediaType: 'tv', id: 281588 })).toBe('a to z')
    expect(sortTitle('A to Z', { mediaType: 'movie', id: 1 })).toBe('to z')
  })
})

describe('queryCatalog', () => {
  test('sorts ignoring a leading article', () => {
    const { titles } = queryCatalog([
      title('The Matrix'),
      title('Avatar'),
      title('A Quiet Place'),
      title('Silo'),
    ], ALL)

    expect(names(titles)).toEqual([
      'Avatar',
      'The Matrix',
      'A Quiet Place',
      'Silo',
    ])
  })

  test('puts the best search match first, then sorts the rest', () => {
    const { titles } = queryCatalog([
      title('The Silo Files'),
      title('Silo: Origins'),
      title('Silo'),
      title('Wild.Tales.2014.1080p-EPSiLON'),
    ], { ...ALL, q: 'silo' })

    expect(names(titles)).toEqual(['Silo', 'Silo: Origins', 'The Silo Files'])
  })

  test('searches and sorts by the TMDB title once it is known', () => {
    const matrix = title('The.Matrix.1999.1080p', {
      metadata: {
        tmdbId: 603,
        title: 'The Matrix',
        overview: null,
        year: 1999,
        rating: null,
        posterUrl: null,
        backdropUrl: null,
        genres: [],
      },
    })
    const { titles } = queryCatalog([
      title('Avatar'),
      matrix,
    ], { ...ALL, q: 'the matrix' })

    expect(titles).toEqual([matrix])
  })

  test('combines type, peer, and genre filters', () => {
    const catalog = [
      title('Silo', {
        mediaType: 'tv',
        genres: ['Drama'],
      }),
      title('Sintel', {
        genres: ['Animation'],
      }),
      title('Avatar', {
        genres: ['Action'],
        peers: [
          {
            id: 'p2',
            name: 'Beta',
            releaseCount: 1,
            totalSize: 1,
            resolutions: [],
          },
        ],
      }),
    ]

    expect(names(queryCatalog(catalog, { ...ALL, type: 'tv' }).titles)).toEqual(['Silo'])
    expect(names(queryCatalog(catalog, {
      ...ALL,
      peers: ['p2'],
    }).titles)).toEqual(['Avatar'])
    expect(names(queryCatalog(catalog, {
      ...ALL,
      genres: ['Animation', 'Drama'],
    }).titles)).toEqual(['Silo', 'Sintel'])
  })

  test('hides owned titles and counts what that removes', () => {
    const catalog = [
      title('Silo', { inLibrary: true }),
      title('Sintel'),
    ]

    const { titles, facets } = queryCatalog(catalog, { ...ALL, hideOwned: true })

    expect(names(titles)).toEqual(['Sintel'])
    expect(facets.owned).toBe(1)
  })

  test('counts facets across the whole catalog', () => {
    const { facets } = queryCatalog([
      title('Silo', {
        mediaType: 'tv',
        genres: ['Drama'],
      }),
      title('Sintel', {
        genres: ['Animation', 'Drama'],
      }),
    ], { ...ALL, type: 'tv' })

    expect(facets.types).toEqual({ all: 2, movie: 1, tv: 1 })
    expect(facets.peers).toEqual({ p1: 2 })
    expect(facets.genres).toEqual([
      { genre: 'Animation', count: 1 },
      { genre: 'Drama', count: 2 },
    ])
  })
})

describe('GET /catalog query parameters', () => {
  function recordingController(onQuery: (query: CatalogQuery) => void) {
    return {
      getCatalog: (query: CatalogQuery) => {
        onQuery(query)
        return {
          peers: [],
          titles: [],
          facets: {},
          sync: { syncing: false, syncedAt: null },
        }
      },
    } as unknown as CatalogController
  }

  test('parses repeated peers and genres, the type, and hideOwned', async () => {
    let received: CatalogQuery | undefined
    const app = getCatalogRouter(recordingController(query => received = query))

    const res = await app.request('/?q=silo&type=tv&peer=p1&peer=p2&genre=Drama&hideOwned=true')

    expect(res.status).toBe(200)
    expect(received).toEqual({
      q: 'silo',
      type: 'tv',
      peers: ['p1', 'p2'],
      genres: ['Drama'],
      hideOwned: true,
    })
  })

  test('defaults to the whole catalog', async () => {
    let received: CatalogQuery | undefined

    await getCatalogRouter(recordingController(query => received = query)).request('/')

    expect(received).toEqual({
      q: undefined,
      type: 'all',
      peers: [],
      genres: [],
      hideOwned: false,
    })
  })
})
