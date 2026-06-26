import type { ArrServerConnector } from '../../lib/servers/arr/base'
import type { PeerConnector } from '../../lib/servers/peer'
import type { TmdbClient } from '../../lib/tmdb/client'
import type { CatalogTitle } from './catalog.lib'
import { NotFoundError } from '../../lib/errors/NotFoundError'
import { groupReleasesIntoTitles, mapLimit } from './catalog.lib'

const TMDB_ENRICH_CONCURRENCY = 8

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
    const titles = await this.enrichTitles(groupReleasesIntoTitles(releases))
    return {
      peer: { id: peer.id, name: peer.name },
      titles,
    }
  }

  private async enrichTitles(titles: CatalogTitle[]): Promise<CatalogTitle[]> {
    if (!this.tmdb)
      return titles
    const tmdb = this.tmdb
    return mapLimit(titles, TMDB_ENRICH_CONCURRENCY, async (title) => {
      if (!title.tmdbId)
        return title
      try {
        const metadata = await tmdb.getMetadata(title.mediaType, title.tmdbId)
        return { ...title, metadata }
      }
      catch {
        // Enrichment is best-effort: a failed lookup must not blank the catalog.
        return title
      }
    })
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
