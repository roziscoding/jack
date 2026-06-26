import type { ArrServerConnector } from '../../lib/servers/arr/base'
import type { PeerConnector } from '../../lib/servers/peer'
import type { TmdbClient } from '../../lib/tmdb/client'
import type { CatalogTitle } from './catalog.lib'
import { NotFoundError } from '../../lib/errors/NotFoundError'
import { groupReleasesIntoTitles } from './catalog.lib'

export interface PeerCatalogResponse {
  peer: { id: string, name: string }
  titles: CatalogTitle[]
}

export interface TmdbStatus {
  configured: boolean
  ok: boolean
  error?: string
}

export class CatalogController {
  constructor(
    private readonly connectors: { servers: ArrServerConnector[], peers: PeerConnector[] },
    private readonly tmdb?: TmdbClient,
  ) {}

  private requirePeer(peerId: string): PeerConnector {
    const peer = this.connectors.peers.find(p => p.id === peerId)
    if (!peer)
      throw new NotFoundError(`No peer found with id "${peerId}"`)
    return peer
  }

  async getPeerCatalog(peerId: string): Promise<PeerCatalogResponse> {
    const peer = this.requirePeer(peerId)
    const releases = await peer.listReleases()
    return {
      peer: { id: peer.id, name: peer.name },
      titles: groupReleasesIntoTitles(releases),
    }
  }

  async getTmdbStatus(): Promise<TmdbStatus> {
    if (!this.tmdb)
      return { configured: false, ok: false }
    try {
      return { configured: true, ok: await this.tmdb.ping() }
    }
    catch (err) {
      return { configured: true, ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }
}
