import type { DownloadStatus } from '../../database/schema'
import type { ArrServerConnector } from '../../lib/servers/arr/base'
import type { ServerConnector } from '../../lib/servers/base'
import type { PeerConnector } from '../../lib/servers/peer'
import type { DownloadRecord, DownloadsRepository } from '../downloads/downloads.repository'
import { DOWNLOAD_STATUSES } from '../../database/schema'

// The management surface can expose richer detail than the public API: every
// connector here carries its URL-derived `id` (the management UI keys edit/delete
// on it) plus its live initialization state, and downloads are enriched with a
// computed `progress` the public download list does not compute.

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

export function enrichDownload(d: DownloadRecord) {
  // Prefer the negotiated expected size; fall back to the release-advertised size.
  const totalBytes = d.expectedBytes ?? (d.releaseSize > 0 ? d.releaseSize : null)
  const progress = totalBytes && totalBytes > 0
    ? Math.min(1, d.downloadedBytes / totalBytes)
    : null
  return { ...d, totalBytes, progress }
}

export class StatusController {
  constructor(
    private readonly connectors: { servers: ArrServerConnector[], peers: PeerConnector[] },
    private readonly downloads?: DownloadsRepository,
  ) {}

  /** Whether download-backed endpoints are available (a repository was injected). */
  get hasDownloads() {
    return this.downloads !== undefined
  }

  getOverview() {
    const peers = this.connectors.peers
    const servers = this.connectors.servers
    const records = this.downloads?.list() ?? []

    const byStatus = Object.fromEntries(DOWNLOAD_STATUSES.map(s => [s, 0])) as Record<DownloadStatus, number>
    for (const record of records)
      byStatus[record.status]++

    return {
      peers: {
        total: peers.length,
        initialized: peers.filter(p => p.isInitialized).length,
        items: peers.map(p => ({ ...baseConnector(p), version: p.peerVersion })),
      },
      servers: {
        total: servers.length,
        initialized: servers.filter(s => s.isInitialized).length,
        sources: servers.filter(s => s.canSource).length,
        destinations: servers.filter(s => s.canDestination).length,
        items: servers.map(s => ({ ...baseConnector(s), source: s.canSource, destination: s.canDestination })),
      },
      downloads: {
        total: records.length,
        byStatus,
        active: records.filter(r => r.status === 'downloading').map(enrichDownload),
      },
    }
  }

  listDownloads() {
    const records = this.downloads?.list() ?? []
    return { downloads: records.map(enrichDownload) }
  }
}
