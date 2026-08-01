import type { ArrServerConnector } from '../../lib/servers/arr/base'
import type { DownloadOperationCoordinator } from './download-operation-coordinator'
import type { DownloadRecord, DownloadsRepository } from './downloads.repository'
import { dirname } from 'node:path'
import { ConflictError } from '../../lib/errors/ConflictError'
import { NotFoundError } from '../../lib/errors/NotFoundError'
import { PermanentManualImportError } from '../../lib/servers/arr/base'
import { logger } from '../../logger'
import { deriveHash } from '../qbittorrent/qbittorrent.mapper'
import { unlinkDownloadArtifact } from './artifact-cleanup'
import { coordinatorFor } from './download-operation-coordinator'

/**
 * Periodically reconciles `import_queued` downloads against the history of each
 * destination Radarr/Sonarr. jack hands a finished file to *arr over the qB API
 * but never gets a callback when *arr imports it, so without this the row would
 * sit at `import_queued` forever. Each tick asks every destination for the
 * infohashes it imported recently and flips the matching rows to `imported`
 * (terminal). The rows are kept, so the downloads list doubles as a history.
 */
export interface ManualImportRetryPolicy {
  /** Give up (mark the row failed) once a trigger has failed this many times. */
  maxAttempts: number
  /** First back-off delay; doubles per failure up to backoffMaxMs. */
  backoffBaseMs: number
  backoffMaxMs: number
}

const DEFAULT_RETRY_POLICY: ManualImportRetryPolicy = {
  maxAttempts: 6,
  backoffBaseMs: 60_000,
  backoffMaxMs: 1_800_000,
}

/**
 * Post-import cleanup of jack's own copy in `completedPath`. `enabled` is read per
 * import (not captured at boot) so toggling `downloads.unlinkImportedFiles` from the
 * management API takes effect without a restart.
 */
export interface ImportedFileCleanup {
  enabled: () => boolean
  completedPath: string
}

export class ImportWatcher {
  private timer?: ReturnType<typeof setInterval>
  // Per-row manual-import trigger failures, so a persistently failing trigger (e.g.
  // *arr 500s because the movie folder is missing) backs off instead of re-firing
  // every tick. In-memory by design: a restart is a fair signal to try again.
  private readonly triggerFailures = new Map<number, { failures: number, nextAttemptAt: number }>()
  private readonly coordinator: DownloadOperationCoordinator
  private tickInFlight?: Promise<number>

  constructor(
    private readonly repository: DownloadsRepository,
    // Only the live `servers` getter is used; accept the structural shape so a
    // real ConnectorManager or a test stub both satisfy it.
    private readonly connectorManager: { servers: ArrServerConnector[] },
    private readonly intervalMs: number,
    private readonly retryPolicy: ManualImportRetryPolicy = DEFAULT_RETRY_POLICY,
    coordinator?: DownloadOperationCoordinator,
    // Omitted → imported files are always kept.
    private readonly importedFileCleanup?: ImportedFileCleanup,
  ) {
    this.coordinator = coordinator ?? coordinatorFor(repository)
  }

  /**
   * Drop jack's copy of a just-imported download when the operator asked for it.
   * Radarr/Sonarr owns the file from here on (hardlinked or copied into the
   * library), so this only frees jack's directory entry — see `unlinkDownloadArtifact`.
   *
   * Runs inside the caller's per-row exclusive section (never takes the lock
   * itself) and never throws: the import already succeeded, so a cleanup failure
   * is logged and the row stays `imported`.
   */
  private async cleanUpImportedFile(row: DownloadRecord): Promise<void> {
    if (!this.importedFileCleanup?.enabled())
      return
    try {
      const unlinked = await unlinkDownloadArtifact(this.repository, row.id, row.destPath, this.importedFileCleanup.completedPath)
      if (unlinked)
        logger.info({ id: row.id, filename: row.filename, path: row.destPath }, 'Unlinked imported file')
    }
    catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      logger.warn({ id: row.id, path: row.destPath, error: message }, 'Could not unlink imported file')
    }
  }

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

  async retry(id: number): Promise<DownloadRecord> {
    return this.coordinator.runExclusive(id, async () => {
      const row = this.repository.get(id)
      if (!row)
        throw new NotFoundError(`Download ${id} not found`)
      if (!row.operationFailed || row.lastOperation !== 'import')
        throw new ConflictError(`Download ${id} has no failed import to retry`)
      if (row.importMode !== 'jack_manual' || !row.importTarget)
        throw new ConflictError(`Download ${id} does not support a manual import retry`)
      const connector = this.connectorFor(row)
      if (!connector?.isInitialized)
        throw new ConflictError(`Destination for download ${id} is unavailable`)

      this.repository.markImportRetryStarted(id)
      try {
        const commandId = await connector.manualImport({
          folder: dirname(row.destPath),
          paths: [row.destPath],
          target: row.importTarget,
          downloadId: deriveHash(row.release.title, row.releaseSize),
          release: row.release,
        })
        this.repository.setManualImportCommand(id, commandId)
        this.triggerFailures.delete(id)
        return this.repository.get(id) ?? row
      }
      catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        this.repository.markFailed(id, message, 'import')
        throw err
      }
    })
  }

  /** One reconciliation pass. Returns how many downloads it marked imported. */
  tick(): Promise<number> {
    if (this.tickInFlight)
      return this.tickInFlight
    const tick = this.tickOnce()
    this.tickInFlight = tick
    void tick.finally(() => {
      if (this.tickInFlight === tick)
        this.tickInFlight = undefined
    }).catch(() => {})
    return tick
  }

  private async tickOnce(): Promise<number> {
    // Only rows with an owning destination can be reconciled; blackhole rows have
    // no server to poll, so they're left as-is.
    const queued = this.repository.listByStatus('import_queued').filter(r => r.sourceServerId || r.qbSourceServer)
    // Forget back-off state for rows that are no longer queued (imported/failed/gone).
    const queuedIds = new Set(queued.map(r => r.id))
    for (const id of this.triggerFailures.keys()) {
      if (!queuedIds.has(id))
        this.triggerFailures.delete(id)
    }
    if (queued.length === 0)
      return 0

    const now = Date.now()
    const importedIdsByConnector = new Map<string, Set<string>>()
    const skippedConnectors = new Set<string>()
    let importedCount = 0

    for (const queuedRow of queued) {
      importedCount += await this.coordinator.runExclusive(queuedRow.id, async () => {
        // Another tick/retry/delete may have changed or removed the row while this
        // operation waited for the per-ID lock. Never act on the stale snapshot.
        const row = this.repository.get(queuedRow.id)
        if (!row || row.status !== 'import_queued')
          return 0
        const connector = this.connectorFor(row)
        if (!connector || !connector.isInitialized)
          return 0

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
          return 0

        const hash = deriveHash(row.release.title, row.releaseSize).toLowerCase()
        if (importedIds.has(hash)) {
          this.repository.markImported(row.id)
          logger.info({ id: row.id, filename: row.filename, server: connector.name }, 'Download imported by *arr')
          await this.cleanUpImportedFile(row)
          return 1
        }

        if (row.importMode !== 'jack_manual' || !row.importTarget)
          return 0

        if (row.manualImportCommandId != null) {
          try {
            const status = await connector.manualImportCommandStatus(row.manualImportCommandId)
            if (status.state === 'completed') {
              this.repository.markImported(row.id)
              logger.info({ id: row.id, filename: row.filename, server: connector.name, commandId: row.manualImportCommandId }, 'Manual import command completed')
              await this.cleanUpImportedFile(row)
              return 1
            }
            if (status.state === 'failed') {
              this.repository.markFailed(row.id, status.error, 'import')
              logger.warn({ id: row.id, server: connector.name, commandId: row.manualImportCommandId, error: status.error }, 'Manual import command failed')
            }
          }
          catch (err) {
            const message = err instanceof Error ? err.message : String(err)
            logger.warn({ id: row.id, server: connector.name, commandId: row.manualImportCommandId, error: message }, 'Could not read manual import command status; will retry next tick')
          }
          return 0
        }

        const backoff = this.triggerFailures.get(row.id)
        if (backoff && now < backoff.nextAttemptAt)
          return 0

        try {
          const commandId = await connector.manualImport({
            folder: dirname(row.destPath),
            paths: [row.destPath],
            target: row.importTarget,
            downloadId: deriveHash(row.release.title, row.releaseSize),
            release: row.release,
          })
          this.repository.setManualImportCommand(row.id, commandId)
          this.triggerFailures.delete(row.id)
          logger.info({ id: row.id, filename: row.filename, server: connector.name, commandId }, 'Triggered *arr manual import')
        }
        catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          if (err instanceof PermanentManualImportError) {
            this.repository.markFailed(row.id, message, 'import')
            this.triggerFailures.delete(row.id)
            logger.warn({ id: row.id, server: connector.name, error: message }, 'Manual import cannot be retried')
            return 0
          }
          const failures = (this.triggerFailures.get(row.id)?.failures ?? 0) + 1
          if (failures >= this.retryPolicy.maxAttempts) {
            this.repository.markFailed(row.id, `manual import failed after ${failures} attempts: ${message}`, 'import')
            this.triggerFailures.delete(row.id)
            logger.warn({ id: row.id, server: connector.name, attempts: failures, error: message }, 'Manual import gave up after repeated failures')
            return 0
          }
          const delayMs = Math.min(this.retryPolicy.backoffMaxMs, this.retryPolicy.backoffBaseMs * 2 ** (failures - 1))
          this.triggerFailures.set(row.id, { failures, nextAttemptAt: now + delayMs })
          logger.warn({ id: row.id, server: connector.name, attempts: failures, retryInMs: delayMs, error: message }, 'Manual import trigger failed; backing off')
        }
        return 0
      })
    }
    return importedCount
  }
}
