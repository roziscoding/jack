import type { Release } from '../lib/release'
import { describe, expect, test } from 'bun:test'
import { releaseToTorznab } from '../modules/torznab/torznab.controller'
import { buildErrorXml, buildSearchResultXml } from '../modules/torznab/torznab.router'

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

const JACK_API_KEY = 'test-api-key'

function attrValue(item: Record<string, any>, name: string): unknown {
  return (item['torznab:attr'] as Array<Record<string, any>>)
    .find(a => a['@name'] === name)?.['@value']
}

describe('Torznab XML helpers', () => {
  test('buildSearchResultXml returns RSS with items', () => {
    const result = buildSearchResultXml([releaseToTorznab(movieRelease, 'peer1', 'Friend', 'http://localhost:3000', JACK_API_KEY)])
    expect(result.rss['@version']).toBe('2.0')
    expect(result.rss['@xmlns:torznab']).toContain('torznab')

    const item = result.rss.channel.item[0]
    expect(item.title).toBe('Test.Movie.2021.1080p.BluRay.x264-GROUP')
    expect(item.guid).toBe('peer1:conn1:movie:42')
    expect(new URL(item.link).searchParams.get('apikey')).toBe(JACK_API_KEY)
    expect(new URL(item.enclosure['@url']).searchParams.get('apikey')).toBe(JACK_API_KEY)
    expect(item.enclosure['@type']).toBe('application/x-bittorrent')
    expect(attrValue(item, 'category')).toBe(2000)
    expect(attrValue(item, 'imdbid')).toBe('tt9999999')
    expect(attrValue(item, 'tmdbid')).toBe(12345)
    expect(attrValue(item, 'downloadvolumefactor')).toBe(0)
    expect(attrValue(item, 'uploadvolumefactor')).toBe(1)
  })

  test('buildSearchResultXml tags every item as an internal release', () => {
    // *arr's TorznabRssParser maps `tag=internal` to the Internal indexer flag,
    // so a custom format (IndexerFlagSpecification) can target Jack releases.
    const result = buildSearchResultXml([releaseToTorznab(movieRelease, 'peer1', 'Friend', 'http://localhost:3000', JACK_API_KEY)])
    const tags = (result.rss.channel.item[0]['torznab:attr'] as Array<Record<string, any>>)
      .filter(a => a['@name'] === 'tag')
      .map(a => a['@value'])
    expect(tags).toContain('internal')
  })

  test('buildSearchResultXml emits tv attrs for episodes', () => {
    const result = buildSearchResultXml([releaseToTorznab(episodeRelease, 'peer1', 'Friend', 'http://localhost:3000', JACK_API_KEY)])
    const item = result.rss.channel.item[0]
    expect(attrValue(item, 'category')).toBe(5000)
    expect(attrValue(item, 'tvdbid')).toBe(654321)
    expect(attrValue(item, 'season')).toBe(1)
    expect(attrValue(item, 'episode')).toBe(2)
  })

  test('buildSearchResultXml handles empty results', () => {
    const result = buildSearchResultXml([])
    expect(result.rss.channel.item).toEqual([])
  })

  test('buildErrorXml returns error element', () => {
    const result = buildErrorXml(100, 'Incorrect API Key')
    expect(result.error['@code']).toBe(100)
    expect(result.error['@description']).toBe('Incorrect API Key')
  })

  test('buildSearchResultXml passes special characters through raw (encoder handles escaping)', () => {
    const release: Release = {
      id: 'conn1:movie:1',
      title: 'Movie <with> "special" & \'chars\'',
      filename: 'movie.mkv',
      category: 2000,
      size: 100,
    }

    const result = buildSearchResultXml([releaseToTorznab(release, 'peer1', undefined, 'http://localhost', JACK_API_KEY)])
    expect(result.rss.channel.item[0].title).toBe('Movie <with> "special" & \'chars\'')
  })
})

describe('releaseToTorznab', () => {
  test('maps a movie release', () => {
    const result = releaseToTorznab(movieRelease, 'peer1', 'Friend', 'http://localhost:3000', JACK_API_KEY)
    expect(result.title).toBe('Test.Movie.2021.1080p.BluRay.x264-GROUP')
    expect(result.category).toBe(2000)
    expect(result.imdbId).toBe('tt9999999')
    expect(result.tmdbId).toBe(12345)
    expect(result.guid).toBe('peer1:conn1:movie:42')
    expect(result.size).toBe(2_000_000_000)
    expect(result.downloadUrl).toContain('/torznab/download/')
    expect(result.downloadUrl).toContain(encodeURIComponent('peer1:conn1:movie:42'))
    expect(new URL(result.downloadUrl).searchParams.get('apikey')).toBe(JACK_API_KEY)
  })

  test('maps an episode release to the TV category with season/episode', () => {
    const result = releaseToTorznab(episodeRelease, 'peer1', 'Friend', 'http://localhost:3000', JACK_API_KEY)
    expect(result.category).toBe(5000)
    expect(result.tvdbId).toBe(654321)
    expect(result.season).toBe(1)
    expect(result.episode).toBe(2)
    expect(result.guid).toBe('peer1:conn2:episode:7')
  })
})
