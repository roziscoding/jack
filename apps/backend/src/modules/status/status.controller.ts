import type { DownloadStatus, UploadStatus } from '../../database/schema'
import type { ArrServerConnector } from '../../lib/servers/arr/base'
import type { ServerConnector } from '../../lib/servers/base'
import type { PeerConnector } from '../../lib/servers/peer'
import type { DownloadRecord, DownloadsRepository } from '../downloads/downloads.repository'
import type { LiveProgressTracker } from '../downloads/live-progress'
import type { UploadRecord } from '../uploads/uploads.repository'
import type { UploadsService } from '../uploads/uploads.service'
import { DOWNLOAD_STATUSES, UPLOAD_STATUSES } from '../../database/schema'
import { liveProgressFor } from '../downloads/live-progress'

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

export function enrichDownload(d: DownloadRecord, live?: LiveProgressTracker) {
  // Prefer the negotiated expected size; fall back to the release-advertised size.
  const totalBytes = d.expectedBytes ?? (d.releaseSize > 0
    ? d.releaseSize
    : null)
  // A running transfer reports bytes about once a second in memory; the row is only
  // written every 10 s / 64 MiB, so prefer the live count while it's downloading.
  const current = d.status === 'downloading'
    ? live?.get(d.id)
    : null
  const downloadedBytes = Math.max(d.downloadedBytes, current?.downloadedBytes ?? 0)
  const progress = totalBytes && totalBytes > 0
    ? Math.min(1, downloadedBytes / totalBytes)
    : null
  const speedBps = current?.speedBps ?? null
  const etaSeconds = speedBps && speedBps > 0 && totalBytes
    ? Math.max(0, Math.round((totalBytes - downloadedBytes) / speedBps))
    : null
  return {
    ...d,
    downloadedBytes,
    totalBytes,
    progress,
    speedBps,
    etaSeconds,
  }
}

export function enrichUpload(u: UploadRecord) {
  // Files go out zero-copy, so only a receipt tells us how far it got. Progress is
  // through the whole file, so a resumed request starts where the range does.
  const progress = u.status === 'completed' && u.totalBytes > 0
    ? Math.min(1, (u.rangeStart + u.sentBytes) / u.totalBytes)
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
  ) {}

  private enrichUpload = (u: UploadRecord) => enrichUpload(u)

  private get live(): LiveProgressTracker | undefined {
    return this.downloads && liveProgressFor(this.downloads)
  }

  private enrich = (d: DownloadRecord) => enrichDownload(d, this.live)

  subscribeOverview(subscriber: () => void): () => void {
    return coalesce(subscriber, [
      this.connectors.subscribe,
      this.downloads && (s => this.downloads!.subscribe(s)),
      this.live && (s => this.live!.subscribe(s)),
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
      this.live && (s => this.live!.subscribe(s)),
    ])
  }

  /** Whether download-backed endpoints are available (a repository was injected). */
  get hasDownloads() {
    return this.downloads !== undefined
  }

  getOverview() {
    const peers = this.connectors.peers
    const servers = this.connectors.servers
    const records = this.downloads?.list() ?? []

    const byStatus = Object.fromEntries(DOWNLOAD_STATUSES.map(s => [s, 0])) as Record<DownloadStatus, number>
    // `bytesMoved` is the lifetime total of bytes actually pulled over the wire
    // (partial transfers count what they got), powering the dashboard's vanity stat.
    let bytesMoved = 0
    // True count of in-flight/queued transfers flagged with a size mismatch, so the
    // dashboard reports an accurate total even though the detail arrays are capped.
    let mismatched = 0
    for (const record of records) {
      byStatus[record.status]++
      bytesMoved += record.downloadedBytes
      if (record.expectedBytesMismatch && (record.status === 'downloading' || record.status === 'import_queued'))
        mismatched++
    }

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
        total: records.length,
        byStatus,
        bytesMoved,
        mismatched,
        // `records` is sorted by updatedAt desc, so each slice is the most recent.
        active: records.filter(r => r.status === 'downloading').map(this.enrich),
        importQueued: records.filter(r => r.status === 'import_queued').slice(0, ATTENTION_LIMIT).map(this.enrich),
        failed: records.filter(r => r.status === 'failed').slice(0, ATTENTION_LIMIT).map(this.enrich),
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
