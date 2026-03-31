import type { BaseItemDto } from '@jack/schemas/jellyfin/types'

function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

export function buildCapsXml(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<caps>
  <server version="1.0" title="Jack" />
  <limits max="100" default="50" />
  <searching>
    <search available="yes" supportedParams="q" />
    <tv-search available="yes" supportedParams="q,tvdbid,season,ep" />
    <movie-search available="yes" supportedParams="q,imdbid" />
  </searching>
  <categories>
    <category id="2000" name="Movies" />
    <category id="5000" name="TV" />
  </categories>
</caps>`
}

export interface TorznabItem {
  title: string
  guid: string
  size: number
  downloadUrl: string
  category: number
  imdbId?: string
  tvdbId?: string
  peerId: string
  peerName?: string
}

function itemToCategory(item: BaseItemDto): number | null {
  switch (item.Type) {
    case 'Movie':
      return 2000
    case 'Series':
    case 'Season':
    case 'Episode':
      return 5000
    default:
      return null
  }
}

export function jellyfinItemToTorznab(item: BaseItemDto, peerId: string, peerName: string | undefined, baseUrl: string): TorznabItem | null {
  const category = itemToCategory(item)
  if (category == null) return null

  const size = item.MediaSources?.[0]?.Size ?? 0
  const guid = `${peerId}:${item.Id}`

  return {
    title: item.Name ?? 'Unknown',
    guid,
    size,
    downloadUrl: `${baseUrl}/torznab/download/${encodeURIComponent(guid)}.torrent`,
    category,
    imdbId: item.ProviderIds?.Imdb ?? undefined,
    tvdbId: item.ProviderIds?.Tvdb ?? undefined,
    peerId,
    peerName,
  }
}

export function buildSearchResultXml(items: TorznabItem[]): string {
  const itemsXml = items.map(item => {
    const attrs: string[] = []
    attrs.push(`<torznab:attr name="category" value="${item.category}" />`)
    attrs.push(`<torznab:attr name="size" value="${item.size}" />`)
    attrs.push(`<torznab:attr name="seeders" value="1" />`)
    attrs.push(`<torznab:attr name="peers" value="1" />`)
    if (item.imdbId) attrs.push(`<torznab:attr name="imdbid" value="${escapeXml(item.imdbId)}" />`)
    if (item.tvdbId) attrs.push(`<torznab:attr name="tvdbid" value="${escapeXml(item.tvdbId)}" />`)

    return `    <item>
      <title>${escapeXml(item.title)}</title>
      <guid>${escapeXml(item.guid)}</guid>
      <size>${item.size}</size>
      <link>${escapeXml(item.downloadUrl)}</link>
      <enclosure url="${escapeXml(item.downloadUrl)}" length="${item.size}" type="application/x-bittorrent" />
      ${attrs.join('\n      ')}
    </item>`
  }).join('\n')

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:torznab="http://torznab.com/schemas/2015/feed">
  <channel>
    <title>Jack</title>
    <description>Jack - Media from friends</description>
${itemsXml}
  </channel>
</rss>`
}

export function buildErrorXml(code: number, description: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<error code="${code}" description="${escapeXml(description)}" />`
}
