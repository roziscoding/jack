import { describe, expect, test } from 'bun:test'
import { buildImageUrl, mapTmdbDetail } from '../lib/tmdb/client'

describe('buildImageUrl', () => {
  test('assembles a full image url from a poster path with the default size', () => {
    expect(buildImageUrl('/abc.jpg')).toBe('https://image.tmdb.org/t/p/w500/abc.jpg')
  })

  test('honors a custom size', () => {
    expect(buildImageUrl('/abc.jpg', 'w780')).toBe('https://image.tmdb.org/t/p/w780/abc.jpg')
  })

  test('returns null for a null path', () => {
    expect(buildImageUrl(null)).toBeNull()
  })

  test('returns null for an undefined path', () => {
    expect(buildImageUrl(undefined)).toBeNull()
  })
})

describe('mapTmdbDetail', () => {
  test('maps a movie detail (title/release_date/vote_average)', () => {
    const meta = mapTmdbDetail({
      id: 550,
      title: 'Fight Club',
      overview: 'A man and his alter ego.',
      release_date: '1999-10-15',
      vote_average: 8.4,
      poster_path: '/poster.jpg',
      backdrop_path: '/backdrop.jpg',
      genres: [{ id: 18, name: 'Drama' }],
    })

    expect(meta.tmdbId).toBe(550)
    expect(meta.title).toBe('Fight Club')
    expect(meta.year).toBe(1999)
    expect(meta.rating).toBe(8.4)
    expect(meta.overview).toBe('A man and his alter ego.')
    expect(meta.posterUrl).toBe('https://image.tmdb.org/t/p/w500/poster.jpg')
    expect(meta.backdropUrl).toBe('https://image.tmdb.org/t/p/w780/backdrop.jpg')
    expect(meta.genres).toEqual(['Drama'])
  })

  test('maps a tv detail from name/first_air_date when title/release_date are absent', () => {
    const meta = mapTmdbDetail({
      id: 1396,
      name: 'Breaking Bad',
      first_air_date: '2008-01-20',
      vote_average: 8.9,
    })

    expect(meta.title).toBe('Breaking Bad')
    expect(meta.year).toBe(2008)
    expect(meta.rating).toBe(8.9)
  })

  test('falls back to null year/rating and empty genres when fields are missing', () => {
    const meta = mapTmdbDetail({ id: 1 })

    expect(meta.title).toBe('Untitled')
    expect(meta.year).toBeNull()
    expect(meta.rating).toBeNull()
    expect(meta.posterUrl).toBeNull()
    expect(meta.backdropUrl).toBeNull()
    expect(meta.genres).toEqual([])
    expect(meta.overview).toBeNull()
  })
})
