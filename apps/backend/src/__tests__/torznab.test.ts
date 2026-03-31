import { describe, test, expect } from 'bun:test'
import { buildCapsXml, buildSearchResultXml, buildErrorXml, jellyfinItemToTorznab } from '../modules/torznab/torznab.xml'
import type { BaseItemDto } from '@jack/schemas/jellyfin/types'

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
    const items = [
      {
        title: 'Test Movie',
        guid: 'peer1:item1',
        size: 1500000000,
        downloadUrl: 'http://localhost:3000/torznab/download/peer1%3Aitem1.torrent',
        category: 2000,
        imdbId: 'tt1234567',
        peerId: 'peer1',
        peerName: 'Friend',
      },
    ]

    const xml = buildSearchResultXml(items)
    expect(xml).toContain('<?xml version="1.0"')
    expect(xml).toContain('<rss version="2.0"')
    expect(xml).toContain('xmlns:torznab=')
    expect(xml).toContain('<title>Test Movie</title>')
    expect(xml).toContain('<guid>peer1:item1</guid>')
    expect(xml).toContain('value="2000"')
    expect(xml).toContain('name="imdbid" value="tt1234567"')
    expect(xml).toContain('type="application/x-bittorrent"')
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
    const items = [
      {
        title: 'Movie <with> "special" & \'chars\'',
        guid: 'peer1:item1',
        size: 100,
        downloadUrl: 'http://localhost/download/test',
        category: 2000,
        peerId: 'peer1',
      },
    ]

    const xml = buildSearchResultXml(items)
    expect(xml).toContain('&lt;with&gt;')
    expect(xml).toContain('&amp;')
    expect(xml).toContain('&quot;special&quot;')
  })

  test('jellyfinItemToTorznab maps Movie correctly', () => {
    const item: Partial<BaseItemDto> = {
      Id: 'abc123',
      Name: 'Test Movie',
      Type: 'Movie',
      ProviderIds: { Imdb: 'tt9999999' },
      MediaSources: [{ Size: 2000000000, Path: '/media/movies/test.mkv' } as any],
    }

    const result = jellyfinItemToTorznab(item as BaseItemDto, 'peer1', 'Friend', 'http://localhost:3000')
    expect(result).not.toBeNull()
    expect(result!.title).toBe('Test Movie')
    expect(result!.category).toBe(2000)
    expect(result!.imdbId).toBe('tt9999999')
    expect(result!.guid).toBe('peer1:abc123')
    expect(result!.downloadUrl).toContain('/torznab/download/')
  })

  test('jellyfinItemToTorznab maps Episode to TV category', () => {
    const item: Partial<BaseItemDto> = {
      Id: 'ep1',
      Name: 'Episode 1',
      Type: 'Episode',
      ProviderIds: { Tvdb: '12345' },
      MediaSources: [{ Size: 500000000 } as any],
    }

    const result = jellyfinItemToTorznab(item as BaseItemDto, 'peer1', 'Friend', 'http://localhost:3000')
    expect(result).not.toBeNull()
    expect(result!.category).toBe(5000)
    expect(result!.tvdbId).toBe('12345')
  })

  test('jellyfinItemToTorznab returns null for unsupported types', () => {
    const item: Partial<BaseItemDto> = {
      Id: 'music1',
      Name: 'Some Song',
      Type: 'Audio' as any,
    }

    const result = jellyfinItemToTorznab(item as BaseItemDto, 'peer1', 'Friend', 'http://localhost:3000')
    expect(result).toBeNull()
  })
})
