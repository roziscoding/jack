import type { DownloadRecord } from './downloads.repository'
import { logger } from '../../logger'

export interface FailedDownloadReaperOptions {
  /** Read every tick, so toggling `downloads.removeFailedDownloads` applies live. */
  enabled: () => boolean
  list: () => DownloadRecord[]
  /** Repeats the row's last failed operation (transfer or import). */
  retry: (id: number) => Promise<unknown>
  /** Deletes the row and its unshared partial or completed files. */
  remove: (id: number) => Promise<unknown>
  maxRetries: number
  baseDelayMs: number
  maxDelayMs: number
  /** Injectable for tests. */
  now?: () => number
}

/** Same rule the UI uses to offer ***Retry***: only these failures can be repeated. */
function canRetry(row: DownloadRecord): boolean {
  if (!row.operationFailed)
    return false
  if (row.lastOperation === 'transfer')
    return true
  return row.lastOperation === 'import' && row.importMode === 'jack_manual' && row.importTarget != null
}

/**
 * Retries failed downloads with exponential backoff and deletes the ones that keep
 * failing. Each tick, a failed row either waits out its backoff, gets retried, or
 * (retries spent, or not retryable) is removed with its files.
 *
 * Retry counts live in memory: a restart starts every row's count over.
 */
export class FailedDownloadReaper {
  // `nextAt` is unset right after a retry fires; the next tick that sees the row
  // failed again schedules the following retry from that moment.
  private readonly state = new Map<number, { retries: number, nextAt?: number }>()
  private timer?: ReturnType<typeof setInterval>
  private tickInFlight?: Promise<void>

  constructor(private readonly options: FailedDownloadReaperOptions) {}

  private delayFor(retries: number): number {
    return Math.min(this.options.maxDelayMs, this.options.baseDelayMs * 2 ** retries)
  }

  start(intervalMs: number): void {
    if (this.timer)
      return
    this.timer = setInterval(() => {
      void this.tick().catch((err) => {
        logger.warn({
          error: err instanceof Error
            ? err.message
            : String(err),
        }, 'Failed download reaper tick failed')
      })
    }, intervalMs)
  }

  stop(): void {
    clearInterval(this.timer)
    this.timer = undefined
  }

  tick(): Promise<void> {
    // One pass at a time: a slow delete must not overlap the next interval.
    this.tickInFlight ??= this.run().finally(() => {
      this.tickInFlight = undefined
    })
    return this.tickInFlight
  }

  private async run(): Promise<void> {
    if (!this.options.enabled())
      return
    const now = (this.options.now ?? Date.now)()
    const rows = this.options.list()

    // Forget rows that are gone or finished, so their ids don't keep stale counts.
    const live = new Map(rows.map(row => [row.id, row]))
    for (const id of this.state.keys()) {
      const status = live.get(id)?.status
      if (status === undefined || status === 'imported')
        this.state.delete(id)
    }

    for (const row of rows) {
      // A user cancel keeps its .part on purpose; leave it for them.
      if (row.status !== 'failed' || row.errorCode === 'CANCELLED')
        continue

      const entry = this.state.get(row.id) ?? { retries: 0 }
      this.state.set(row.id, entry)

      if (entry.nextAt === undefined) {
        if (entry.retries >= this.options.maxRetries || !canRetry(row)) {
          await this.removeRow(row, entry.retries)
          continue
        }
        entry.nextAt = now + this.delayFor(entry.retries)
        continue
      }
      if (now < entry.nextAt)
        continue

      entry.retries++
      entry.nextAt = undefined
      try {
        await this.options.retry(row.id)
        logger.info({
          id: row.id,
          filename: row.filename,
          retry: entry.retries,
          maxRetries: this.options.maxRetries,
        }, 'Retrying failed download')
      }
      catch (err) {
        // Counts as a spent retry; the next tick schedules the following one.
        logger.warn({
          id: row.id,
          retry: entry.retries,
          error: err instanceof Error
            ? err.message
            : String(err),
        }, 'Could not retry failed download')
      }
    }
  }

  private async removeRow(row: DownloadRecord, retries: number): Promise<void> {
    try {
      await this.options.remove(row.id)
      this.state.delete(row.id)
      logger.info({
        id: row.id,
        filename: row.filename,
        retries,
        error_code: row.errorCode,
      }, 'Removed failed download')
    }
    catch (err) {
      // State is kept, so the next tick tries the removal again.
      logger.warn({
        id: row.id,
        error: err instanceof Error
          ? err.message
          : String(err),
      }, 'Could not remove failed download')
    }
  }
}
