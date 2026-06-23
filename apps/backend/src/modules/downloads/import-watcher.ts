import type { ArrServerConnector } from '../../lib/servers/arr/base'
import type { DownloadsRepository } from './downloads.repository'
import { logger } from '../../logger'
import { deriveHash } from '../qbittorrent/qbittorrent.mapper'

/**
 * Periodically reconciles `import_queued` downloads against the history of each
 * destination Radarr/Sonarr. jack hands a finished file to *arr over the qB API
 * but never gets a callback when *arr imports it, so without this the row would
 * sit at `import_queued` forever. Each tick asks every destination for the
 * infohashes it imported recently and flips the matching rows to `imported`
 * (terminal). The rows are kept, so the downloads list doubles as a history.
 */
export class ImportWatcher {
  private timer?: ReturnType<typeof setInterval>

  constructor(
    private readonly repository: DownloadsRepository,
    // Only the live `servers` getter is used; accept the structural shape so a
    // real ConnectorManager or a test stub both satisfy it.
    private readonly connectorManager: { servers: ArrServerConnector[] },
    private readonly intervalMs: number,
  ) {}

  start(): void {
    if (this.timer)
      return
    this.timer = setInterval(() => {
      void this.tick().catch((err) => {
        const message = err instanceof Error ? err.message : String(err)
        logger.error({ error: message }, 'Import watcher tick failed')
      })
    }, this.intervalMs)
    // Don't keep the process alive solely for the watcher.
    this.timer.unref?.()
  }

  stop(): void {
    if (!this.timer)
      return
    clearInterval(this.timer)
    this.timer = undefined
  }

  /** One reconciliation pass. Returns how many downloads it marked imported. */
  async tick(): Promise<number> {
    // Only qB-added downloads (qbSourceServer set) are imported by an *arr we can
    // poll; blackhole rows have no server to ask, so they're left as-is.
    const queued = this.repository.list().filter(r => r.status === 'import_queued' && r.qbSourceServer)
    if (queued.length === 0)
      return 0

    const byServer = new Map<string, typeof queued>()
    for (const row of queued) {
      const group = byServer.get(row.qbSourceServer!) ?? []
      group.push(row)
      byServer.set(row.qbSourceServer!, group)
    }

    let importedCount = 0
    for (const [serverName, rows] of byServer) {
      const connector = this.connectorManager.servers.find(s => s.name === serverName)
      if (!connector || !connector.isInitialized)
        continue

      let importedIds: Set<string>
      try {
        importedIds = await connector.recentlyImportedDownloadIds()
      }
      catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        logger.warn({ server: serverName, error: message }, 'Could not read import history; will retry next tick')
        continue
      }

      for (const row of rows) {
        const hash = deriveHash(row.release.title, row.releaseSize).toLowerCase()
        if (!importedIds.has(hash))
          continue
        this.repository.markImported(row.id)
        importedCount++
        logger.info({ id: row.id, filename: row.filename, server: serverName }, 'Download imported by *arr')
      }
    }
    return importedCount
  }
}
