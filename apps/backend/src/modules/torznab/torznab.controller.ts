import type { AppConfig } from '../../lib/config'
import type { Release } from '../../lib/release'
import type { PeerConnector } from '../../lib/servers/peer'
import { withSpan } from '../../lib/tracing'
import { logger } from '../../logger'

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

function buildDownloadUrl(baseUrl: string, guid: string, apiKey: string): string {
  const trimmedBaseUrl = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl
  const url = new URL(`${trimmedBaseUrl}/torznab/download/${encodeURIComponent(guid)}.torrent`)
  url.searchParams.set('apikey', apiKey)
  return url.toString()
}

export function releaseToTorznab(release: Release, peerId: string, peerName: string | undefined, baseUrl: string, apiKey: string): TorznabItem {
  const guid = `${peerId}:${release.id}`

  return {
    title: release.title,
    guid,
    size: release.size,
    downloadUrl: buildDownloadUrl(baseUrl, guid, apiKey),
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

export class TorznabController {
  constructor(
    private readonly peers: PeerConnector[],
    private readonly jackConfig: NonNullable<AppConfig['jack']>,
  ) {}

  private async fanOut(label: string, search: (peer: PeerConnector) => Promise<Release[]>): Promise<TorznabItem[]> {
    // We fan out to ALL peers — no isInitialized pre-filter. A peer that failed
    // to connect at boot gets re-initialized lazily by @requireInitialization on
    // the call below, so a peer that came back online rejoins searches without a
    // restart. Each peer is isolated: if it fails (still down, or errors), we log
    // and treat it as zero results instead of failing the whole search.
    return withSpan('torznab.fan_out', {
      'search.label': label,
      'peer.count': this.peers.length,
    }, async (span) => {
      if (this.peers.length === 0) {
        span.setAttribute('release.count', 0)
        return []
      }

      const results = await Promise.all(
        this.peers.map(async (peer) => {
          try {
            return await withSpan('torznab.peer_search', {
              'search.label': label,
              'peer.name': peer.name,
              'peer.id': peer.id,
            }, async (peerSpan) => {
              const releases = await search(peer)
              peerSpan.setAttribute('release.count', releases.length)
              return releases.map(release => releaseToTorznab(release, peer.id, peer.name, this.jackConfig.baseUrl, this.jackConfig.apiKey))
            })
          }
          catch (err) {
            logger.error({ search: label, peer: peer.name, err }, 'Peer search failed — skipping this peer')
            return []
          }
        }),
      )

      const items = results.flat()
      span.setAttribute('release.count', items.length)
      return items
    })
  }

  async searchMovie(ids: { tmdbId?: string, imdbId?: string }): Promise<TorznabItem[]> {
    const { tmdbId, imdbId } = ids
    // Prefer tmdbid: Radarr filters by it server-side (a targeted lookup), and it
    // doesn't depend on the tt-prefix quirk. imdbid is the fallback.
    if (tmdbId)
      return this.fanOut(`tmdb:${tmdbId}`, peer => peer.searchByTmdbId(tmdbId))
    if (imdbId)
      return this.fanOut(`imdb:${imdbId}`, peer => peer.searchByImdbId(imdbId))
    return []
  }

  async searchTv(tvdbId: string, season?: number, episode?: number): Promise<TorznabItem[]> {
    return this.fanOut(`tvdb:${tvdbId} s:${season ?? '-'} e:${episode ?? '-'}`, peer => peer.searchByTvdbId(tvdbId, season, episode))
  }

  /** Full catalog of every peer's releases — backs the torznab RSS/test query. */
  async catalog(): Promise<TorznabItem[]> {
    return this.fanOut('catalog', peer => peer.listReleases())
  }
}
