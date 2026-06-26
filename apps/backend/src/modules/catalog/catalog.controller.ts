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

export interface RequestServerOption {
  id: string
  name: string
  type: 'radarr' | 'sonarr'
  mediaType: 'movie' | 'tv'
  qualityProfiles: Array<{ id: number, name: string }>
  rootFolders: Array<{ path: string, freeSpace?: number }>
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

  async getRequestOptions(): Promise<RequestServerOption[]> {
    const destinations = this.connectors.servers.filter(s => s.canDestination && s.isInitialized)
    const options = await Promise.all(destinations.map(async (s) => {
      try {
        const [qualityProfiles, rootFolders] = await Promise.all([s.getQualityProfiles(), s.getRootFolders()])
        const type = s.type as 'radarr' | 'sonarr'
        return {
          id: s.id,
          name: s.name,
          type,
          mediaType: type === 'sonarr' ? 'tv' : 'movie',
          qualityProfiles,
          rootFolders,
        } satisfies RequestServerOption
      }
      catch {
        // A destination that can't list its profiles can't take a request — drop it.
        return null
      }
    }))
    return options.filter((o): o is RequestServerOption => o !== null)
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
