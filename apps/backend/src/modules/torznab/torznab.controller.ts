import type { AppConfig } from '../../lib/config'
import type { PeerConnector } from '../../lib/servers/peer'
import type { TorznabItem } from './torznab.xml'
import { logger } from '../../logger'
import { releaseToTorznab } from './torznab.xml'

export class TorznabController {
  constructor(
    private readonly peers: PeerConnector[],
    private readonly jackConfig: NonNullable<AppConfig['jack']>,
  ) {}

  private async fanOut(label: string, search: (peer: PeerConnector) => Promise<Awaited<ReturnType<PeerConnector['searchItems']>>>): Promise<TorznabItem[]> {
    // We fan out to ALL peers — no isInitialized pre-filter. A peer that failed
    // to connect at boot gets re-initialized lazily by @requireInitialization on
    // the call below, so a peer that came back online rejoins searches without a
    // restart. Each peer is isolated: if it fails (still down, or errors), we log
    // and treat it as zero results instead of failing the whole search.
    logger.debug({ search: label, peers: this.peers.length }, 'Fanning out search to peers')

    if (this.peers.length === 0) {
      logger.warn({ search: label }, 'No peers configured — returning no results')
      return []
    }

    const results = await Promise.all(
      this.peers.map(async (peer) => {
        try {
          const releases = await search(peer)
          logger.debug({ search: label, peer: peer.name, count: releases.length }, 'Peer returned releases')
          return releases.map(release => releaseToTorznab(release, peer.id, peer.name, this.jackConfig.baseUrl))
        }
        catch (err) {
          logger.error({ search: label, peer: peer.name, err }, 'Peer search failed — skipping this peer')
          return []
        }
      }),
    )

    const items = results.flat()
    logger.debug({ search: label, total: items.length }, 'Fan-out complete')
    return items
  }

  async search(query: string): Promise<TorznabItem[]> {
    return this.fanOut(`q:"${query}"`, peer => peer.searchItems(query))
  }

  async searchMovie(imdbId: string): Promise<TorznabItem[]> {
    return this.fanOut(`imdb:${imdbId}`, peer => peer.searchByImdbId(imdbId))
  }

  async searchTv(tvdbId: string, season?: number, episode?: number): Promise<TorznabItem[]> {
    return this.fanOut(`tvdb:${tvdbId} s:${season ?? '-'} e:${episode ?? '-'}`, peer => peer.searchByTvdbId(tvdbId, season, episode))
  }
}
