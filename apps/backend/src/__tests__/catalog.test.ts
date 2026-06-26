import type { Release } from '../lib/release'
import { describe, expect, test } from 'bun:test'
import { NotFoundError } from '../lib/errors/NotFoundError'
import { CatalogController } from '../modules/catalog/catalog.controller'
import { groupReleasesIntoTitles } from '../modules/catalog/catalog.lib'

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
