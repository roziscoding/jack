import type { PeerCatalogTitle } from '../../lib/peer-catalog'
import type { Release } from '../../lib/release'
import type { ArrServerConnector, CatalogEntry, LibraryEntry } from '../../lib/servers/arr/base'
import type { PeerConnector } from '../../lib/servers/peer'
import type { CatalogCacheRepository } from './catalog-cache.repository'
import type { OwnCatalogEntry, OwnCatalogRepository } from './own-catalog.repository'
import type { TmdbMetadataRepository } from './tmdb-metadata.repository'
import { ReleaseCategory } from '../../lib/release'
import { setSpanAttributes } from '../../lib/span-attributes'
import { withSpan } from '../../lib/tracing'
import { logger } from '../../logger'
import { indexPeerTitles, mergeTitle, peerTitleKey, summarizeReleases } from './catalog.lib'

/**
 * Key source entries the way the catalog is keyed. Two sources can carry the
 * same title (e.g. a 4K and a 1080p Radarr): their summaries merge and their
 * releases are kept side by side.
 */
export function indexEntries(entries: CatalogEntry[]): Map<string, OwnCatalogEntry> {
  const byKey = new Map<string, OwnCatalogEntry>()
  for (const { title, releases } of entries) {
    const key = peerTitleKey(title)
    const existing = byKey.get(key)
    if (existing) {
      mergeTitle(existing.title, title)
      existing.releases.push(...releases)
    }
    else {
      // Copied, since mergeTitle mutates it when a second source carries the title.
      byKey.set(key, {
        title: { ...title },
        releases: [...releases],
      })
    }
  }
  return byKey
}

export interface CatalogSyncStatus {
  syncing: boolean
  // When the last sync finished; null before the first one.
  syncedAt: string | null
}

export interface CatalogSyncDeps {
  connectors: { servers: ArrServerConnector[], peers: PeerConnector[] }
  own: OwnCatalogRepository
  peerCache: CatalogCacheRepository
  // Stored TMDB lookups, to cache old peers' movies under their TMDB title.
  metadata?: Pick<TmdbMetadataRepository, 'get'>
  // The current cron expression; read again on every reschedule().
  schedule: () => string
}

/**
 * Keeps the catalogs current, on a cron schedule and on demand:
 *
 * - this instance's own catalog, read from the source Radarr/Sonarr and served
 *   to peers from the cache
 * - every peer's catalog, fetched as changes since the last revision applied
 * - the local library, which marks the titles already owned
 *
 * Searching the Peer Catalog only reads what this leaves in the cache.
 */
export class CatalogSyncService {
  private library: LibraryEntry[] = []
  private running: Promise<void> | null = null
  private job: Bun.CronJob | null = null
  private activeSchedule: string | null = null
  private syncedAt: string | null = null

  constructor(private readonly deps: CatalogSyncDeps) {}

  /** The local library as of the last sync. */
  get libraryEntries(): LibraryEntry[] {
    return this.library
  }

  get status(): CatalogSyncStatus {
    return { syncing: this.running !== null, syncedAt: this.syncedAt }
  }

  /** Sync now, or join the sync already running. Never rejects. */
  sync(): Promise<void> {
    this.running ??= this.run().finally(() => this.running = null)
    return this.running
  }

  /** Sync once in the background, then on the configured schedule. */
  start(): void {
    void this.sync()
    this.reschedule()
  }

  /**
   * Apply the current schedule if it changed. An invalid expression keeps the
   * previous job (config validation should have rejected it already).
   */
  reschedule(): void {
    const schedule = this.deps.schedule()
    if (schedule === this.activeSchedule)
      return
    try {
      // Bun.cron never overlaps runs; a throw here would crash the process, and
      // sync() never rejects.
      const job = Bun.cron(schedule, () => this.sync())
      this.job?.stop()
      this.job = job
      this.activeSchedule = schedule
      logger.info({ schedule }, 'Catalog sync scheduled')
    }
    catch (err) {
      logger.error({ schedule, err }, 'Invalid catalog sync schedule; keeping the previous one')
    }
  }

  /**
   * Reflect one download *arr just imported without waiting for the next sync:
   * mark it as owned, and refresh that one title in the own catalog so peers get
   * it on their next sync. Never rejects; the next full sync corrects anything
   * this misses.
   */
  async addImported(release: Release): Promise<void> {
    const mediaType = release.category === ReleaseCategory.Tv
      ? 'tv'
      : 'movie'
    this.library = [
      ...this.library,
      {
        mediaType,
        tmdbId: release.tmdbId,
        imdbId: release.imdbId,
        tvdbId: release.tvdbId,
      },
    ]

    const only = mediaType === 'tv'
      ? { tvdbId: release.tvdbId }
      : { tmdbId: release.tmdbId }
    if (only.tmdbId == null && only.tvdbId == null)
      return

    await withSpan('catalog.add_imported', { 'catalog.media_type': mediaType, 'catalog.tmdb_id': only.tmdbId, 'catalog.tvdb_id': only.tvdbId }, async (span) => {
      try {
        const sources = this.deps.connectors.servers.filter(s => s.canSource)
        const results = await Promise.allSettled(sources.map(source => source.listCatalog(only)))
        // Without every source, the title's totals would come out short; leave it
        // to the next full sync.
        if (results.some(result => result.status === 'rejected')) {
          logger.warn({ only }, 'Could not read every source; the imported title joins the catalog on the next sync')
          return
        }
        const entries = results.flatMap(result => result.status === 'fulfilled'
          ? result.value
          : [])
        let changed = 0
        for (const [titleKey, entry] of indexEntries(entries)) {
          if (this.deps.own.applyTitle(titleKey, entry))
            changed++
        }
        setSpanAttributes(span, { 'title.changed_count': changed })
      }
      catch (err) {
        logger.warn({ only, err }, 'Could not add the imported title to the catalog')
      }
    })
  }

  stop(): void {
    this.job?.stop()
    this.job = null
    this.activeSchedule = null
  }

  private async run(): Promise<void> {
    try {
      await withSpan('catalog.sync', {}, async () => {
        await Promise.all([
          this.syncOwn(),
          this.syncLibrary(),
          this.syncPeers(),
        ])
      })
      this.syncedAt = new Date().toISOString()
    }
    catch (err) {
      logger.error({ err }, 'Catalog sync failed')
    }
  }

  private async syncOwn(): Promise<void> {
    // Sources gated by config only, like PeerController: listCatalog re-inits a
    // source that failed at boot.
    const sources = this.deps.connectors.servers.filter(s => s.canSource)
    await withSpan('catalog.sync_own', { 'source.count': sources.length }, async (span) => {
      const results = await Promise.allSettled(sources.map(source => source.listCatalog()))
      const failed = results.flatMap((result, i) => result.status === 'rejected'
        ? [
            { source: sources[i]!.name, err: result.reason },
          ]
        : [])
      // A failed source would read as every one of its titles being removed, and
      // peers would drop them until the next sync. Keep the last catalog instead.
      if (failed.length > 0) {
        logger.warn({ failed }, 'Could not read every source; keeping the previous own catalog')
        return
      }
      const entries = results.flatMap(result => result.status === 'fulfilled'
        ? result.value
        : [])
      const diff = this.deps.own.applySnapshot(indexEntries(entries))
      setSpanAttributes(span, {
        'title.count': entries.length,
        'title.added_count': diff.added.size,
        'title.updated_count': diff.updated.size,
        'title.removed_count': diff.removed.length,
      })
    })
  }

  // A server that can't list its library would unmark everything it owns, so a
  // failure keeps the previous library.
  private async syncLibrary(): Promise<void> {
    const servers = this.deps.connectors.servers.filter(s => s.isInitialized)
    try {
      const libraries = await Promise.all(servers.map(s => s.listLibrary()))
      this.library = libraries.flat()
    }
    catch (err) {
      logger.warn({ err }, 'Could not read the local library; keeping the previous one')
    }
  }

  private async syncPeers(): Promise<void> {
    const configured = this.deps.connectors.peers
    this.deps.peerCache.deleteOrphans(configured.map(p => p.id))
    // Offline peers keep their cached catalog until they answer again.
    await Promise.all(configured.filter(p => p.isInitialized).map(peer => this.syncPeer(peer)))
  }

  private async syncPeer(peer: PeerConnector): Promise<void> {
    await withSpan('catalog.sync_peer', { 'peer.name': peer.name, 'peer.id': peer.id }, async (span) => {
      try {
        const since = this.deps.peerCache.getRevision(peer.id)
        const result = await peer.listCatalog(since)
        if (result.kind === 'releases') {
          const titles = summarizeReleases(result.releases).map(title => this.withTmdbTitle(title))
          this.deps.peerCache.applyPeerCatalog(peer.id, indexPeerTitles(titles))
          this.deps.peerCache.setRevision(peer.id, null)
          setSpanAttributes(span, { 'catalog.format': 'releases', 'title.count': titles.length })
          return
        }
        const titles = indexPeerTitles(result.titles.map(title => this.withTmdbTitle(title)))
        if (result.full)
          this.deps.peerCache.applyPeerCatalog(peer.id, titles)
        else
          this.deps.peerCache.applyPeerChanges(peer.id, titles, result.removed)
        this.deps.peerCache.setRevision(peer.id, result.revision)
        setSpanAttributes(span, {
          'catalog.format': 'titles',
          'catalog.full': result.full,
          'catalog.revision': result.revision,
          'title.count': titles.size,
          'title.removed_count': result.removed.length,
        })
      }
      catch (err) {
        logger.warn({ peer: peer.name, err }, 'Could not sync the peer catalog; keeping the cached one')
      }
    })
  }

  /**
   * Movies are cached under their TMDB title. Peers on 0.2.0+ already send it
   * (from Radarr); for older ones, which only have the scene name, use a stored
   * TMDB lookup when there is one.
   */
  private withTmdbTitle(title: PeerCatalogTitle): PeerCatalogTitle {
    if (title.mediaType !== 'movie' || title.tmdbId == null)
      return title
    const tmdbTitle = this.deps.metadata?.get('movie', title.tmdbId)?.title
    return tmdbTitle
      ? { ...title, title: tmdbTitle }
      : title
  }
}
