import { describe, expect, test } from 'bun:test'
import type { Release } from '../lib/release'
import { buildCapsXml, buildErrorXml, buildSearchResultXml, releaseToTorznab } from '../modules/torznab/torznab.xml'

const movieRelease: Release = {
  id: 'conn1:movie:42',
  title: 'Test.Movie.2021.1080p.BluRay.x264-GROUP',
  filename: 'Test.Movie.2021.1080p.BluRay.x264-GROUP.mkv',
  category: 2000,
  size: 2_000_000_000,
  imdbId: 'tt9999999',
  tmdbId: 12345,
  quality: { name: 'Bluray-1080p', source: 'bluray', resolution: 1080 },
  releaseGroup: 'GROUP',
}

const episodeRelease: Release = {
  id: 'conn2:episode:7',
  title: 'Show.S01E02.1080p.WEB-DL-GRP',
  filename: 'Show.S01E02.1080p.WEB-DL-GRP.mkv',
  category: 5000,
  size: 500_000_000,
  tvdbId: 654321,
  season: 1,
  episode: 2,
  seriesTitle: 'Show',
}

describe('Torznab XML helpers', () => {
  test('buildCapsXml returns valid XML with categories', () => {
    const xml = buildCapsXml()
    expect(xml).toContain('<?xml version="1.0"')
    expect(xml).toContain('<caps>')
    expect(xml).toContain('category id="2000" name="Movies"')
    expect(xml).toContain('category id="5000" name="TV"')
    expect(xml).toContain('movie-search available="yes"')
    expect(xml).toContain('tv-search available="yes"')
  })

  test('buildSearchResultXml returns RSS with items', () => {
    const xml = buildSearchResultXml([releaseToTorznab(movieRelease, 'peer1', 'Friend', 'http://localhost:3000')])
    expect(xml).toContain('<?xml version="1.0"')
    expect(xml).toContain('<rss version="2.0"')
    expect(xml).toContain('xmlns:torznab=')
    expect(xml).toContain('<title>Test.Movie.2021.1080p.BluRay.x264-GROUP</title>')
    expect(xml).toContain('<guid>peer1:conn1:movie:42</guid>')
    expect(xml).toContain('value="2000"')
    expect(xml).toContain('name="imdbid" value="tt9999999"')
    expect(xml).toContain('name="tmdbid" value="12345"')
    expect(xml).toContain('name="downloadvolumefactor" value="0"')
    expect(xml).toContain('name="uploadvolumefactor" value="1"')
    expect(xml).toContain('type="application/x-bittorrent"')
  })

  test('buildSearchResultXml emits tv attrs for episodes', () => {
    const xml = buildSearchResultXml([releaseToTorznab(episodeRelease, 'peer1', 'Friend', 'http://localhost:3000')])
    expect(xml).toContain('value="5000"')
    expect(xml).toContain('name="tvdbid" value="654321"')
    expect(xml).toContain('name="season" value="1"')
    expect(xml).toContain('name="episode" value="2"')
  })

  test('buildSearchResultXml handles empty results', () => {
    const xml = buildSearchResultXml([])
    expect(xml).toContain('<channel>')
    expect(xml).not.toContain('<item>')
  })

  test('buildErrorXml returns error element', () => {
    const xml = buildErrorXml(100, 'Incorrect API Key')
    expect(xml).toContain('code="100"')
    expect(xml).toContain('description="Incorrect API Key"')
  })

  test('buildSearchResultXml escapes XML special characters', () => {
    const release: Release = {
      id: 'conn1:movie:1',
      title: 'Movie <with> "special" & \'chars\'',
      filename: 'movie.mkv',
      category: 2000,
      size: 100,
    }

    const xml = buildSearchResultXml([releaseToTorznab(release, 'peer1', undefined, 'http://localhost')])
    expect(xml).toContain('&lt;with&gt;')
    expect(xml).toContain('&amp;')
    expect(xml).toContain('&quot;special&quot;')
  })
})

describe('releaseToTorznab', () => {
  test('maps a movie release', () => {
    const result = releaseToTorznab(movieRelease, 'peer1', 'Friend', 'http://localhost:3000')
    expect(result.title).toBe('Test.Movie.2021.1080p.BluRay.x264-GROUP')
    expect(result.category).toBe(2000)
    expect(result.imdbId).toBe('tt9999999')
    expect(result.tmdbId).toBe(12345)
    expect(result.guid).toBe('peer1:conn1:movie:42')
    expect(result.size).toBe(2_000_000_000)
    expect(result.downloadUrl).toContain('/torznab/download/')
    expect(result.downloadUrl).toContain(encodeURIComponent('peer1:conn1:movie:42'))
  })

  test('maps an episode release to the TV category with season/episode', () => {
    const result = releaseToTorznab(episodeRelease, 'peer1', 'Friend', 'http://localhost:3000')
    expect(result.category).toBe(5000)
    expect(result.tvdbId).toBe(654321)
    expect(result.season).toBe(1)
    expect(result.episode).toBe(2)
    expect(result.guid).toBe('peer1:conn2:episode:7')
  })
})
