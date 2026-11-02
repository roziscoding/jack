import type { ArrServerConnector } from '../../lib/servers/arr/base'
import type { PeerConnector } from '../../lib/servers/peer'
import type { TmdbClient, TmdbMediaType, TmdbMetadata } from '../../lib/tmdb/client'
import type { DownloadsService } from '../downloads/downloads.service'
import type { CatalogSyncService, CatalogSyncStatus } from './catalog-sync.service'
import type { UnifiedCatalogTitle } from './catalog.lib'
import type { CatalogFacets, CatalogQuery } from './catalog.query'
import type { TmdbMetadataRepository } from './tmdb-metadata.repository'
import { openMemoryDatabase } from '../../database/connection'
import { BadRequestError } from '../../lib/errors/BadRequestError'
import { NotFoundError } from '../../lib/errors/NotFoundError'
import { CatalogCacheRepository } from './catalog-cache.repository'
import { groupPeerCatalogs, markInLibrary, pickBestPerEpisode, pickBestRelease } from './catalog.lib'
import { queryCatalog } from './catalog.query'

export interface CatalogResponse {
  // Configured peers with titles in the cache.
  peers: Array<{ id: string, name: string }>
  // The titles matching the query, ranked and sorted.
  titles: UnifiedCatalogTitle[]
  facets: CatalogFacets
  sync: CatalogSyncStatus
}

const ALL_TITLES: CatalogQuery = {
  type: 'all',
  peers: [],
  genres: [],
  hideOwned: false,
}

const NEVER_SYNCED: CatalogSyncStatus = { syncing: false, syncedAt: null }

/** Attach stored TMDB lookups; their genres join the *arr ones so the genre filter sees both. */
function attachMetadata(titles: UnifiedCatalogTitle[], metadata: Map<string, TmdbMetadata | null> | undefined): void {
  if (!metadata)
    return
  for (const title of titles) {
    if (title.tmdbId == null)
      continue
    const entry = metadata.get(`${title.mediaType}:${title.tmdbId}`)
    if (entry === undefined)
      continue
    title.metadata = entry
    if (entry?.genres.length) {
      title.genres = [
        ...new Set([
          ...title.genres,
          ...entry.genres,
        ]),
      ]
    }
  }
}

export interface CatalogStores {
  // Defaults to an in-memory database, so the cache only lives as long as the process.
  catalog?: CatalogCacheRepository
  // Stored TMDB lookups, attached to the titles they belong to.
  metadata?: Pick<TmdbMetadataRepository, 'all'>
  // Fills the cache; also the source of the local library that marks owned titles.
  sync?: Pick<CatalogSyncService, 'sync' | 'status' | 'libraryEntries'>
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
  peerId: string
  serverId: string
  mediaType: 'movie' | 'tv'
  tmdbId?: number
  tvdbId?: number
  rootFolderPath: string
}

export class CatalogController {
  private readonly cache: CatalogCacheRepository

  constructor(
    private readonly connectors: { servers: ArrServerConnector[], peers: PeerConnector[] },
    private readonly tmdb?: TmdbClient,
    private readonly downloads?: DownloadsService,
    private readonly stores: CatalogStores = {},
  ) {
    this.cache = stores.catalog ?? new CatalogCacheRepository(openMemoryDatabase())
  }

  private requirePeer(peerId: string): PeerConnector {
    const peer = this.connectors.peers.find(p => p.id === peerId)
    if (!peer)
      throw new NotFoundError(`No peer found with id "${peerId}"`)
    return peer
  }

  /**
   * The titles matching `query`, from the cache the catalog sync keeps. Never
   * contacts a peer, so offline peers show their last known catalog.
   */
  getCatalog(query: CatalogQuery = ALL_TITLES): CatalogResponse {
    const configured = this.connectors.peers
    const cached = this.cache.listByPeer(configured.map(p => p.id))
    const catalogs = configured
      .filter(p => cached.has(p.id))
      .map(p => ({
        peer: { id: p.id, name: p.name },
        titles: cached.get(p.id)!,
      }))

    const all = groupPeerCatalogs(catalogs)
    markInLibrary(all, this.stores.sync?.libraryEntries ?? [])
    attachMetadata(all, this.stores.metadata?.all())
    return {
      peers: catalogs.map(c => c.peer),
      ...queryCatalog(all, query),
      sync: this.stores.sync?.status ?? NEVER_SYNCED,
    }
  }

  /** Sync now (or wait for the sync already running), then report its status. */
  async refresh(): Promise<CatalogSyncStatus> {
    if (!this.stores.sync)
      return NEVER_SYNCED
    await this.stores.sync.sync()
    return this.stores.sync.status
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
          mediaType: type === 'sonarr'
            ? 'tv'
            : 'movie',
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

  async requestDownload(input: CatalogRequestInput): Promise<{ ok: true, server: string, started: number }> {
    if (!this.downloads)
      throw new BadRequestError('Downloads are not configured on this Jack instance')

    const server = this.connectors.servers.find(s => s.id === input.serverId)
    if (!server)
      throw new NotFoundError(`No server found with id "${input.serverId}"`)
    if (!server.canDestination)
      throw new BadRequestError(`Server "${server.name}" is not a destination`)
    // Defense in depth (the UI already filters): a movie must go to Radarr, tv to Sonarr.
    const expectedType = input.mediaType === 'tv'
      ? 'sonarr'
      : 'radarr'
    if (server.type !== expectedType)
      throw new BadRequestError(`Server "${server.name}" cannot handle ${input.mediaType} requests`)

    const peer = this.requirePeer(input.peerId)

    if (input.mediaType === 'movie') {
      if (input.tmdbId == null)
        throw new BadRequestError('A tmdbId is required for a movie request')
      const releases = await peer.searchByTmdbId(String(input.tmdbId))
      const best = pickBestRelease(releases)
      if (!best)
        throw new NotFoundError(`Peer "${peer.name}" has no release for tmdbId ${input.tmdbId}`)

      const movieId = await server.add({ tmdbId: input.tmdbId, rootFolderPath: input.rootFolderPath })
      const result = await this.downloads.startDirectDownload({
        peerId: peer.id,
        itemId: best.id,
        destinationServerName: server.name,
        destinationServerId: server.id,
        importTarget: { kind: 'movie', movieId },
      })
      if (result === 'failed')
        throw new BadRequestError(`Failed to start the download for tmdbId ${input.tmdbId} from peer "${peer.name}"`)
      if (result === 'duplicate')
        return { ok: true, server: server.name, started: 0 }
      return { ok: true, server: server.name, started: 1 }
    }

    // --- series (tv): one direct download per best-per-episode release, all bound
    // to the same series so the watcher imports each file into the right show. ---
    if (input.tvdbId == null)
      throw new BadRequestError('A tvdbId is required for a series request')
    const episodeReleases = await peer.searchByTvdbId(String(input.tvdbId))
    const best = pickBestPerEpisode(episodeReleases)
    if (best.length === 0)
      throw new NotFoundError(`Peer "${peer.name}" has no episodes for tvdbId ${input.tvdbId}`)

    const seriesId = await server.add({ tvdbId: input.tvdbId, rootFolderPath: input.rootFolderPath })
    let started = 0
    let accepted = 0
    for (const release of best) {
      const result = await this.downloads.startDirectDownload({
        peerId: peer.id,
        itemId: release.id,
        destinationServerId: server.id,
        destinationServerName: server.name,
        importTarget: { kind: 'series', seriesId },
      })
      if (result === 'failed')
        continue
      accepted++
      if (result === 'started')
        started++
    }
    if (accepted === 0)
      throw new BadRequestError(`Failed to start any episode download for tvdbId ${input.tvdbId} from peer "${peer.name}"`)
    return { ok: true, server: server.name, started }
  }

  async getTmdbStatus(): Promise<TmdbStatus> {
    if (!this.tmdb)
      return { configured: false, ok: false }
    try {
      return { configured: true, ok: await this.tmdb.ping() }
    }
    catch (err) {
      return {
        configured: true,
        ok: false,
        error: err instanceof Error
          ? err.message
          : String(err),
      }
    }
  }
}
