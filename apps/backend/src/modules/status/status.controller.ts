import type { DownloadStatus, UploadStatus } from '../../database/schema'
import type { ArrServerConnector } from '../../lib/servers/arr/base'
import type { ServerConnector } from '../../lib/servers/base'
import type { PeerConnector } from '../../lib/servers/peer'
import type { DownloadRecord, DownloadsRepository } from '../downloads/downloads.repository'
import type { DashboardStats, StatsRange } from '../stats/stats'
import type { StatsRepository } from '../stats/stats.repository'
import type { UploadRecord } from '../uploads/uploads.repository'
import type { UploadsService } from '../uploads/uploads.service'
import { DOWNLOAD_STATUSES, UPLOAD_STATUSES } from '../../database/schema'
import { rangeBuckets, STATS_RANGES } from '../stats/stats'

// The management surface can expose richer detail than the public API: every
// connector here carries its URL-derived `id` (the management UI keys edit/delete
// on it) plus its live initialization state, and downloads are enriched with a
// computed `progress` the public download list does not compute.

// Cap the detail lists the dashboard's "needs attention" panel renders. The true
// totals still come through `byStatus`; these arrays only feed the first few rows.
const ATTENTION_LIMIT = 25

function baseConnector(c: ServerConnector) {
  return {
    id: c.id,
    name: c.name,
    url: c.url,
    type: c.type,
    initialized: c.isInitialized,
    initializationError: c.initializationError,
  }
}

// Progress is written at least every 10 s while bytes arrive; a row quiet for
// longer than this is stalled, so its last speed no longer holds.
const SPEED_STALE_MS = 30_000

export function enrichDownload(d: DownloadRecord, now = Date.now()) {
  // Prefer the negotiated expected size; fall back to the release-advertised size.
  const totalBytes = d.expectedBytes ?? (d.releaseSize > 0
    ? d.releaseSize
    : null)
  const progress = totalBytes && totalBytes > 0
    ? Math.min(1, d.downloadedBytes / totalBytes)
    : null
  // Measured between progress writes (every 10 s / 64 MiB); only while bytes
  // still arrive. A failed attempt clears it before its retry wait.
  const speedBps = d.status === 'downloading' && now - Date.parse(d.updatedAt) <= SPEED_STALE_MS
    ? d.speedBps
    : null
  const etaSeconds = speedBps && speedBps > 0 && totalBytes
    ? Math.max(0, Math.round((totalBytes - d.downloadedBytes) / speedBps))
    : null
  return {
    ...d,
    totalBytes,
    progress,
    speedBps,
    etaSeconds,
  }
}

export function enrichUpload(u: UploadRecord) {
  // Files go out zero-copy, so only a receipt says the file arrived.
  const progress = u.status === 'completed'
    ? 1
    : null
  // Average over the whole transfer, from the receipt; unknown without one.
  const speedBps = u.durationMs && u.durationMs > 0
    ? (u.sentBytes * 1000) / u.durationMs
    : null
  return { ...u, progress, speedBps }
}

type ChangeSource = ((subscriber: () => void) => () => void) | undefined

// Each stream sends a full snapshot per notification, so all of its sources are
// folded together: the first change goes out at once, and any further changes
// within the interval become a single trailing snapshot.
export const STREAM_INTERVAL_MS = 1000

export function coalesce(subscriber: () => void, sources: ChangeSource[], intervalMs = STREAM_INTERVAL_MS): () => void {
  let lastFired = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  const fire = () => {
    timer = undefined
    lastFired = Date.now()
    subscriber()
  }
  const notify = () => {
    if (timer)
      return
    const wait = lastFired + intervalMs - Date.now()
    if (wait <= 0) {
      fire()
      return
    }
    timer = setTimeout(fire, wait)
  }
  const unsubscribers = sources.flatMap(source => source
    ? [
        source(notify),
      ]
    : [])
  return () => {
    clearTimeout(timer)
    for (const unsubscribe of unsubscribers)
      unsubscribe()
  }
}

export class StatusController {
  constructor(
    private readonly connectors: { servers: ArrServerConnector[], peers: PeerConnector[], subscribe?: (subscriber: () => void) => () => void },
    private readonly downloads?: DownloadsRepository,
    private readonly uploads?: UploadsService,
    private readonly stats?: StatsRepository,
  ) {}

  private enrichUpload = (u: UploadRecord) => enrichUpload(u)

  private enrich = (d: DownloadRecord) => enrichDownload(d)

  subscribeOverview(subscriber: () => void): () => void {
    return coalesce(subscriber, [
      // Called through the object: ConnectorManager.subscribe reads `this`.
      this.connectors.subscribe && (s => this.connectors.subscribe!(s)),
      this.downloads && (s => this.downloads!.subscribe(s)),
      this.uploads && (s => this.uploads!.subscribe(s)),
    ])
  }

  subscribeUploads(subscriber: () => void): () => void {
    return coalesce(subscriber, [
      this.uploads && (s => this.uploads!.subscribe(s)),
    ])
  }

  subscribeDownloads(subscriber: () => void): () => void {
    return coalesce(subscriber, [
      this.downloads && (s => this.downloads!.subscribe(s)),
    ])
  }

  /** Whether download-backed endpoints are available (a repository was injected). */
  get hasDownloads() {
    return this.downloads !== undefined
  }

  getOverview() {
    const peers = this.connectors.peers
    const servers = this.connectors.servers
    // This runs on every overview snapshot (about once a second while downloads
    // move), so totals come from SQLite and only the rows shown are loaded. The
    // detail lists are capped; `mismatched` still counts every flagged row.
    const totals = this.downloads?.summary() ?? {
      byStatus: Object.fromEntries(DOWNLOAD_STATUSES.map(s => [s, 0])) as Record<DownloadStatus, number>,
      total: 0,
      bytesMoved: 0,
      mismatched: 0,
    }
    const inStatus = (status: DownloadStatus, limit?: number) => (this.downloads?.listByStatus(status, limit) ?? []).map(this.enrich)

    return {
      peers: {
        total: peers.length,
        initialized: peers.filter(p => p.isInitialized).length,
        items: peers.map(p => ({
          ...baseConnector(p),
          version: p.peerVersion,
        })),
      },
      servers: {
        total: servers.length,
        initialized: servers.filter(s => s.isInitialized).length,
        sources: servers.filter(s => s.canSource).length,
        destinations: servers.filter(s => s.canDestination).length,
        items: servers.map(s => ({
          ...baseConnector(s),
          source: s.canSource,
          destination: s.canDestination,
        })),
      },
      downloads: {
        ...totals,
        // Most recently updated first.
        active: inStatus('downloading'),
        importQueued: inStatus('import_queued', ATTENTION_LIMIT),
        failed: inStatus('failed', ATTENTION_LIMIT),
      },
      uploads: this.getUploadsSummary(),
    }
  }

  // Runs on every overview snapshot (about once a second while downloads move), so
  // totals come from SQLite and only running uploads are loaded: the history
  // grows forever.
  private getUploadsSummary() {
    if (!this.uploads) {
      return {
        total: 0,
        byStatus: Object.fromEntries(UPLOAD_STATUSES.map(s => [s, 0])) as Record<UploadStatus, number>,
        bytesSent: 0,
        active: [],
      }
    }
    return {
      ...this.uploads.repository.summary(),
      active: this.uploads.repository.listActive().map(this.enrichUpload),
    }
  }

  /** Chart data for the dashboard: the history window `range` plus lifetime rankings. */
  getStats(range: StatsRange): DashboardStats {
    // Aggregated in SQLite: the history is never loaded for a chart.
    return this.stats?.dashboard(range) ?? {
      range,
      bucketMs: STATS_RANGES[range].bucketMs,
      buckets: rangeBuckets(range),
      importSummary: {
        minSeconds: null,
        avgSeconds: null,
        maxSeconds: null,
        count: 0,
      },
      transfers: [],
      importLatency: [],
      peers: { gaveToMe: [], tookFromMe: [] },
      failures: [],
      topTitles: [],
      catalog: { sources: [], points: [] },
    }
  }

  listUploads() {
    const records = this.uploads?.list() ?? []
    return {
      uploads: records.map(this.enrichUpload),
    }
  }

  listDownloads() {
    const records = this.downloads?.list() ?? []
    return {
      downloads: records.map(this.enrich),
    }
  }
}
