import type { JackServerConnector } from '../../lib/servers/sources/jack'
import type { AppConfig } from '../../lib/config'
import { jellyfinItemToTorznab, type TorznabItem } from './torznab.xml'

export class TorznabController {
  constructor(
    private readonly peers: JackServerConnector[],
    private readonly jackConfig: NonNullable<AppConfig['jack']>,
  ) {}

  async search(query: string): Promise<TorznabItem[]> {
    const activePeers = this.peers.filter(p => p.isInitialized)
    const results = await Promise.all(
      activePeers.map(async (peer) => {
        const items = await peer.searchItems(query)
        return items
          .map(item => jellyfinItemToTorznab(item, peer.id, peer.name, this.jackConfig.baseUrl))
          .filter((item): item is TorznabItem => item != null)
      }),
    )
    return results.flat()
  }

  async searchMovie(imdbId: string): Promise<TorznabItem[]> {
    const activePeers = this.peers.filter(p => p.isInitialized)
    const results = await Promise.all(
      activePeers.map(async (peer) => {
        const items = await peer.searchByImdbId(imdbId)
        return items
          .map(item => jellyfinItemToTorznab(item, peer.id, peer.name, this.jackConfig.baseUrl))
          .filter((item): item is TorznabItem => item != null)
      }),
    )
    return results.flat()
  }

  async searchTv(tvdbId: string, season?: number, episode?: number): Promise<TorznabItem[]> {
    const activePeers = this.peers.filter(p => p.isInitialized)
    const results = await Promise.all(
      activePeers.map(async (peer) => {
        const items = await peer.searchByTvdbId(tvdbId, season, episode)
        return items
          .map(item => jellyfinItemToTorznab(item, peer.id, peer.name, this.jackConfig.baseUrl))
          .filter((item): item is TorznabItem => item != null)
      }),
    )
    return results.flat()
  }
}
