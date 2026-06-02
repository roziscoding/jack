import type { PeerConnector } from '../../lib/servers/peer'
import type { AppConfig } from '../../lib/config'
import { releaseToTorznab, type TorznabItem } from './torznab.xml'

export class TorznabController {
  constructor(
    private readonly peers: PeerConnector[],
    private readonly jackConfig: NonNullable<AppConfig['jack']>,
  ) {}

  private async fanOut(search: (peer: PeerConnector) => Promise<Awaited<ReturnType<PeerConnector['searchItems']>>>): Promise<TorznabItem[]> {
    const activePeers = this.peers.filter(p => p.isInitialized)
    const results = await Promise.all(
      activePeers.map(async (peer) => {
        const releases = await search(peer)
        return releases.map(release => releaseToTorznab(release, peer.id, peer.name, this.jackConfig.baseUrl))
      }),
    )
    return results.flat()
  }

  async search(query: string): Promise<TorznabItem[]> {
    return this.fanOut(peer => peer.searchItems(query))
  }

  async searchMovie(imdbId: string): Promise<TorznabItem[]> {
    return this.fanOut(peer => peer.searchByImdbId(imdbId))
  }

  async searchTv(tvdbId: string, season?: number, episode?: number): Promise<TorznabItem[]> {
    return this.fanOut(peer => peer.searchByTvdbId(tvdbId, season, episode))
  }
}
