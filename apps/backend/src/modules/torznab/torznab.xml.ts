import type { Release } from '../../lib/release'

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
    <movie-search available="yes" supportedParams="q,imdbid,tmdbid" />
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
  tmdbId?: number
  tvdbId?: number
  season?: number
  episode?: number
  publishDate?: string
  peerId: string
  peerName?: string
}

export function releaseToTorznab(release: Release, peerId: string, peerName: string | undefined, baseUrl: string): TorznabItem {
  const guid = `${peerId}:${release.id}`

  return {
    title: release.title,
    guid,
    size: release.size,
    downloadUrl: `${baseUrl}/torznab/download/${encodeURIComponent(guid)}.torrent`,
    category: release.category,
    imdbId: release.imdbId,
    tmdbId: release.tmdbId,
    tvdbId: release.tvdbId,
    season: release.season,
    episode: release.episode,
    publishDate: release.publishDate,
    peerId,
    peerName,
  }
}

export function buildSearchResultXml(items: TorznabItem[]): string {
  const itemsXml = items.map((item) => {
    const attrs: string[] = []
    attrs.push(`<torznab:attr name="category" value="${item.category}" />`)
    attrs.push(`<torznab:attr name="size" value="${item.size}" />`)
    attrs.push(`<torznab:attr name="seeders" value="1" />`)
    attrs.push(`<torznab:attr name="peers" value="1" />`)
    // Jack files are always freely available; tell *arr not to weight ratio.
    attrs.push(`<torznab:attr name="downloadvolumefactor" value="0" />`)
    attrs.push(`<torznab:attr name="uploadvolumefactor" value="1" />`)
    if (item.imdbId) attrs.push(`<torznab:attr name="imdbid" value="${escapeXml(item.imdbId)}" />`)
    if (item.tmdbId != null) attrs.push(`<torznab:attr name="tmdbid" value="${item.tmdbId}" />`)
    if (item.tvdbId != null) attrs.push(`<torznab:attr name="tvdbid" value="${item.tvdbId}" />`)
    if (item.season != null) attrs.push(`<torznab:attr name="season" value="${item.season}" />`)
    if (item.episode != null) attrs.push(`<torznab:attr name="episode" value="${item.episode}" />`)

    const pubDate = item.publishDate ? new Date(item.publishDate) : new Date()
    const pubDateStr = Number.isNaN(pubDate.getTime()) ? new Date().toUTCString() : pubDate.toUTCString()

    return `    <item>
      <title>${escapeXml(item.title)}</title>
      <guid>${escapeXml(item.guid)}</guid>
      <pubDate>${pubDateStr}</pubDate>
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
