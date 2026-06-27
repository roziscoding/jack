import type { ArrServerConnector } from '../../lib/servers/arr/base'
import type { PeerConnector } from '../../lib/servers/peer'
import type { TmdbClient, TmdbMediaType, TmdbMetadata } from '../../lib/tmdb/client'
import type { CatalogTitle } from './catalog.lib'
import { BadRequestError } from '../../lib/errors/BadRequestError'
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

export interface RequestServerOption {
  id: string
  name: string
  type: 'radarr' | 'sonarr'
  mediaType: 'movie' | 'tv'
  rootFolders: Array<{ path: string, freeSpace?: number }>
}

export interface CatalogRequestInput {
  serverId: string
  mediaType: 'movie' | 'tv'
  tmdbId?: number
  tvdbId?: number
  rootFolderPath: string
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
    // Return titles immediately, unenriched. TMDB lookups are driven per-title by
    // the client (see getTitleMetadata) so the catalog renders without waiting on
    // hundreds of upstream round-trips.
    return {
      peer: { id: peer.id, name: peer.name },
      titles: groupReleasesIntoTitles(releases),
    }
  }

  /** TMDB metadata for a single title; null when TMDB is unconfigured or the id is unknown. */
  async getTitleMetadata(mediaType: TmdbMediaType, tmdbId: number): Promise<TmdbMetadata | null> {
    if (!this.tmdb)
      return null
    return this.tmdb.getMetadata(mediaType, tmdbId)
  }

  async getRequestOptions(): Promise<RequestServerOption[]> {
    const destinations = this.connectors.servers.filter(s => s.canDestination && s.isInitialized)
    const options = await Promise.all(destinations.map(async (s) => {
      try {
        const rootFolders = await s.getRootFolders()
        const type = s.type as 'radarr' | 'sonarr'
        return {
          id: s.id,
          name: s.name,
          type,
          mediaType: type === 'sonarr' ? 'tv' : 'movie',
          rootFolders,
        } satisfies RequestServerOption
      }
      catch {
        // A destination that can't list its root folders can't take a request — drop it.
        return null
      }
    }))
    return options.filter((o): o is RequestServerOption => o !== null)
  }

  async requestDownload(input: CatalogRequestInput): Promise<{ ok: true, server: string }> {
    const server = this.connectors.servers.find(s => s.id === input.serverId)
    if (!server)
      throw new NotFoundError(`No server found with id "${input.serverId}"`)
    if (!server.canDestination)
      throw new BadRequestError(`Server "${server.name}" is not a destination`)
    // Defense in depth (the UI already filters): a movie must go to Radarr, tv to Sonarr.
    const expectedType = input.mediaType === 'tv' ? 'sonarr' : 'radarr'
    if (server.type !== expectedType)
      throw new BadRequestError(`Server "${server.name}" cannot handle ${input.mediaType} requests`)

    // Force Jack's dedicated profile so *arr only grabs this release from the Jack
    // indexer (the profile rejects releases without the Internal flag).
    const qualityProfileId = await server.ensureJackQualityProfile()
    await server.addAndSearch({
      tmdbId: input.tmdbId,
      tvdbId: input.tvdbId,
      qualityProfileId,
      rootFolderPath: input.rootFolderPath,
    })
    return { ok: true, server: server.name }
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
