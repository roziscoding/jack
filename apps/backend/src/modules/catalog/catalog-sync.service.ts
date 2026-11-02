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
 * Key one source's entries the way the catalog is keyed. A source listing the
 * same title twice gets one entry with the summaries merged and the releases
 * side by side.
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
      // Copied, since mergeTitle mutates it when the title comes up again.
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
 * Searching the Peer Catalog only reads what this leaves in the cache. Full
 * syncs and import refreshes run one at a time, so a sync that read the sources
 * before an import can't undo it.
 */
export class CatalogSyncService {
  // Each server's library as of its last successful read.
  private readonly libraryByServer = new Map<string, LibraryEntry[]>()
  // Titles marked owned by an import since, tagged with when, so a library read
  // only retires the ones it could have seen.
  private imported: Array<{ seq: number, entry: LibraryEntry }> = []
  private importSeq = 0
  private queue: Promise<unknown> = Promise.resolve()
  private running: Promise<void> | null = null
  private job: Bun.CronJob | null = null
  private activeSchedule: string | null = null
  private syncedAt: string | null = null

  constructor(private readonly deps: CatalogSyncDeps) {}

  /** The local library as of the last sync, plus anything imported since. */
  get libraryEntries(): LibraryEntry[] {
    return [
      ...[
        ...this.libraryByServer.values(),
      ].flat(),
      ...this.imported.map(i => i.entry),
    ]
  }

  get status(): CatalogSyncStatus {
    return { syncing: this.running !== null, syncedAt: this.syncedAt }
  }

  /** Sync now, or join the sync already running or queued. Never rejects. */
  sync(): Promise<void> {
    this.running ??= this.exclusive(() => this.run()).finally(() => this.running = null)
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

  stop(): void {
    this.job?.stop()
    this.job = null
    this.activeSchedule = null
  }

  /**
   * Reflect one download *arr just imported without waiting for the next sync:
   * mark it as owned right away, and refresh that one title in the own catalog
   * so peers get it on their next sync. Never rejects; the next full sync
   * corrects anything this misses.
   */
  async addImported(release: Release): Promise<void> {
    const mediaType = release.category === ReleaseCategory.Tv
      ? 'tv'
      : 'movie'
    this.imported.push({
      seq: ++this.importSeq,
      entry: {
        mediaType,
        tmdbId: release.tmdbId,
        imdbId: release.imdbId,
        tvdbId: release.tvdbId,
      },
    })

    const only = mediaType === 'tv'
      ? { tvdbId: release.tvdbId }
      : { tmdbId: release.tmdbId }
    if (only.tmdbId == null && only.tvdbId == null)
      return
    const titleKey = peerTitleKey({
      mediaType,
      ...only,
      title: '',
      releaseCount: 0,
      totalSize: 0,
      resolutions: [],
    })

    await this.exclusive(() => withSpan('catalog.add_imported', {
      'catalog.media_type': mediaType,
      'catalog.tmdb_id': only.tmdbId,
      'catalog.tvdb_id': only.tvdbId,
    }, async () => {
      try {
        const sources = this.deps.connectors.servers.filter(s => s.canSource)
        const results = await Promise.allSettled(sources.map(source => source.listCatalog(only)))
        for (const [i, result] of results.entries()) {
          // A source that can't be read keeps what it had for this title.
          if (result.status === 'fulfilled')
            this.deps.own.replaceSource(sources[i]!.id, indexEntries(result.value), [titleKey])
          else
            logger.warn({ source: sources[i]!.name, only, err: result.reason }, 'Could not read the imported title from a source')
        }
        this.deps.own.merge(sources.map(s => s.id))
      }
      catch (err) {
        logger.warn({ only, err }, 'Could not add the imported title to the catalog')
      }
    }))
  }

  /** Run `task` after every task queued before it. */
  private exclusive<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task)
    this.queue = run.catch(() => {})
    return run
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
      for (const [i, result] of results.entries()) {
        // A source that can't be read keeps its last titles instead of having
        // them all read as removed.
        if (result.status === 'fulfilled')
          this.deps.own.replaceSource(sources[i]!.id, indexEntries(result.value))
        else
          logger.warn({ source: sources[i]!.name, err: result.reason }, 'Could not read a source; keeping its previous catalog')
      }
      const ids = sources.map(s => s.id)
      // Sources removed from the config, or no longer sources, drop out here.
      this.deps.own.dropSourcesExcept(ids)
      const diff = this.deps.own.merge(ids)
      setSpanAttributes(span, {
        'source.failed_count': results.filter(r => r.status === 'rejected').length,
        'title.added_count': diff.added.size,
        'title.updated_count': diff.updated.size,
        'title.removed_count': diff.removed.length,
      })
    })
  }

  // A server that can't be read keeps its previous library, so its titles don't
  // lose their owned mark; servers no longer configured drop out.
  private async syncLibrary(): Promise<void> {
    const servers = this.deps.connectors.servers
    const cutoff = this.importSeq
    const results = await Promise.allSettled(servers.map(s => s.listLibrary()))
    for (const [i, result] of results.entries()) {
      if (result.status === 'fulfilled')
        this.libraryByServer.set(servers[i]!.id, result.value)
      else
        logger.warn({ server: servers[i]!.name, err: result.reason }, 'Could not read a library; keeping its previous one')
    }
    const ids = new Set(servers.map(s => s.id))
    for (const id of this.libraryByServer.keys()) {
      if (!ids.has(id))
        this.libraryByServer.delete(id)
    }
    // Imports that happened before this read are in it now, but only if every
    // library was read: the import landed in one of them, and we don't know which.
    if (results.every(result => result.status === 'fulfilled'))
      this.imported = this.imported.filter(i => i.seq > cutoff)
  }

  private async syncPeers(): Promise<void> {
    const configured = this.deps.connectors.peers
    this.deps.peerCache.deleteOrphans(configured.map(p => p.id))
    // Every configured peer is asked: listCatalog retries the handshake of one
    // that was offline. A peer that still can't answer keeps its cached catalog.
    await Promise.all(configured.map(peer => this.syncPeer(peer)))
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
        this.deps.peerCache.setRevision(peer.id, result.revision, result.generation)
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
