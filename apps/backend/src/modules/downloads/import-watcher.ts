import type { ArrServerConnector } from '../../lib/servers/arr/base'
import type { DownloadRecord, DownloadsRepository } from './downloads.repository'
import { dirname } from 'node:path'
import { PermanentManualImportError } from '../../lib/servers/arr/base'
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

  private connectorFor(row: DownloadRecord): ArrServerConnector | undefined {
    if (row.sourceServerId) {
      const byId = this.connectorManager.servers.find(s => s.id === row.sourceServerId)
      if (byId)
        return byId
    }
    return row.qbSourceServer ? this.connectorManager.servers.find(s => s.name === row.qbSourceServer) : undefined
  }

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
    // Only rows with an owning destination can be reconciled; blackhole rows have
    // no server to poll, so they're left as-is.
    const queued = this.repository.listByStatus('import_queued').filter(r => r.sourceServerId || r.qbSourceServer)
    if (queued.length === 0)
      return 0

    const importedIdsByConnector = new Map<string, Set<string>>()
    const skippedConnectors = new Set<string>()
    let importedCount = 0

    for (const row of queued) {
      const connector = this.connectorFor(row)
      if (!connector || !connector.isInitialized)
        continue

      if (!importedIdsByConnector.has(connector.id) && !skippedConnectors.has(connector.id)) {
        try {
          importedIdsByConnector.set(connector.id, await connector.recentlyImportedDownloadIds())
        }
        catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          skippedConnectors.add(connector.id)
          logger.warn({ server: connector.name, error: message }, 'Could not read import history; will retry next tick')
        }
      }
      const importedIds = importedIdsByConnector.get(connector.id)
      if (!importedIds)
        continue

      const hash = deriveHash(row.release.title, row.releaseSize).toLowerCase()
      if (importedIds.has(hash)) {
        this.repository.markImported(row.id)
        importedCount++
        logger.info({ id: row.id, filename: row.filename, server: connector.name }, 'Download imported by *arr')
        continue
      }

      if (row.importMode !== 'jack_manual' || !row.importTarget)
        continue

      // Item-level reconciliation: ask *arr whether the target item (movieId /
      // seriesId) already holds a file matching this release. This catches imports
      // the history query above misses — completed before the history window, or
      // recorded under a downloadId we can't reconstruct — so a row *arr has
      // clearly already satisfied is retired instead of re-triggering the manual
      // import (and flooding *arr) on every tick.
      try {
        if (await connector.hasImportedRelease(row.importTarget, row.release)) {
          this.repository.markImported(row.id)
          importedCount++
          logger.info({ id: row.id, filename: row.filename, server: connector.name }, 'Target item already holds this release; marking imported')
          continue
        }
      }
      catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        logger.warn({ id: row.id, server: connector.name, error: message }, 'Could not check target item import status; will retry next tick')
      }

      if (row.manualImportCommandId != null) {
        try {
          const status = await connector.manualImportCommandStatus(row.manualImportCommandId)
          if (status.state === 'completed') {
            this.repository.markImported(row.id)
            importedCount++
            logger.info({ id: row.id, filename: row.filename, server: connector.name, commandId: row.manualImportCommandId }, 'Manual import command completed')
          }
          else if (status.state === 'failed') {
            this.repository.markFailed(row.id, status.error)
            logger.warn({ id: row.id, server: connector.name, commandId: row.manualImportCommandId, error: status.error }, 'Manual import command failed')
          }
        }
        catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          logger.warn({ id: row.id, server: connector.name, commandId: row.manualImportCommandId, error: message }, 'Could not read manual import command status; will retry next tick')
        }
        continue
      }

      try {
        const commandId = await connector.manualImport({
          folder: dirname(row.destPath),
          paths: [row.destPath],
          target: row.importTarget,
          downloadId: deriveHash(row.release.title, row.releaseSize),
          release: row.release,
        })
        this.repository.setManualImportCommand(row.id, commandId)
        logger.info({ id: row.id, filename: row.filename, server: connector.name, commandId }, 'Triggered *arr manual import')
      }
      catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        if (err instanceof PermanentManualImportError) {
          this.repository.markFailed(row.id, message)
          logger.warn({ id: row.id, server: connector.name, error: message }, 'Manual import cannot be retried')
          continue
        }
        logger.warn({ id: row.id, server: connector.name, error: message }, 'Manual import trigger failed; will retry next tick')
      }
    }
    return importedCount
  }
}
