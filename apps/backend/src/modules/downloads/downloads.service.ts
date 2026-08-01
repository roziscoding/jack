import type { AppConfig } from '../../lib/config'
import type { ConnectorManager } from '../../lib/servers'
import type { ManualImportTarget } from '../../lib/servers/arr/base'
import type { PeerDownloadProgressEvent } from '../../lib/servers/peer'
import type { DownloadOperationCoordinator } from './download-operation-coordinator'
import type { DownloadRecord, DownloadsRepository } from './downloads.repository'
import { basename, join, resolve } from 'node:path'
import { ConflictError } from '../../lib/errors/ConflictError'
import { NotFoundError } from '../../lib/errors/NotFoundError'
import { retry } from '../../lib/retry'
import { Semaphore } from '../../lib/semaphore'
import { logger } from '../../logger'
import { unlinkDownloadArtifact } from './artifact-cleanup'
import { coordinatorFor } from './download-operation-coordinator'
import { downloadRetryAfterMs, isTransientDownloadError } from './retry-policy'

type DownloadsServiceConfig = NonNullable<AppConfig['downloads']>

// Characters disallowed in the synthetic qB torrent filename (keep word chars, dot, dash).
const UNSAFE_FILENAME_CHARS = /[^\w.-]/g

/**
 * Outcome of a qB add:
 * - 'started' — a new download row was created and is running.
 * - 'duplicate' — a download for the same destination is already in flight; the
 *   add is a no-op but still a success (the release is being fetched).
 * - 'failed' — no row could be created (unknown peer or an unsafe peer filename).
 */
export type StartQbDownloadResult = 'started' | 'duplicate' | 'failed'

// createDownload's internal outcome: a record to run, a benign duplicate, or no peer.
type CreateDownloadOutcome
  = | { kind: 'created', record: DownloadRecord }
    | { kind: 'duplicate' }
    | { kind: 'no-peer' }

export class DownloadsService {
  private readonly semaphore: Semaphore
  // Dest paths with a download in flight — guards two concurrent live drops that
  // resolve to the same destination (no duplicate rows / writers).
  private readonly active = new Set<string>()
  private readonly transfers = new Map<number, { controller: AbortController, task: Promise<void> }>()
  private readonly coordinator?: DownloadOperationCoordinator

  constructor(
    private readonly config: DownloadsServiceConfig,
    // Only the live `peers` getter is used; accept the structural shape so a real
    // ConnectorManager (live) or a test stub both satisfy it.
    private readonly connectorManager: { peers: ConnectorManager['peers'] },
    private readonly downloadsRepository?: DownloadsRepository,
    coordinator?: DownloadOperationCoordinator,
  ) {
    this.semaphore = new Semaphore(config.maxConcurrentDownloads)
    this.coordinator = coordinator ?? (downloadsRepository ? coordinatorFor(downloadsRepository) : undefined)
  }

  private get peers() {
    return this.connectorManager.peers
  }

  private requireRepository(): DownloadsRepository {
    if (!this.downloadsRepository)
      throw new ConflictError('Download management is unavailable')
    return this.downloadsRepository
  }

  /**
   * Shared creation core for the qB add path. Returns the created record, a
   * benign duplicate (a download for the same destination is already active),
   * or no-peer when the peer is unknown. Throws on an unsafe filename.
   */
  private async createDownload(input: {
    peerId: string
    itemId: string
    torrentFilename: string
    qbCategory?: string | null
    qbSourceServer?: string | null
    sourceServerId?: string | null
    importMode?: 'jack_manual' | null
    importTarget?: ManualImportTarget | null
  }): Promise<CreateDownloadOutcome> {
    const { peerId, itemId, torrentFilename } = input
    const peer = this.peers.find(p => p.id === peerId)
    if (!peer) {
      logger.error({ torrentFilename, peerId }, 'Peer not found')
      return { kind: 'no-peer' }
    }

    const release = await peer.getRelease(itemId)

    // `release.filename` is peer-controlled and only validated as a string.
    // Force it to a plain basename inside `completedPath` so a value like
    // `../../evil.mkv` or an absolute path cannot escape the directory.
    const safeName = basename(release.filename)
    const isSafeName = safeName.length > 0 && safeName !== '.' && safeName !== '..'
      && !safeName.includes('/') && !safeName.includes('\\')
      && release.filename === safeName
    if (!isSafeName)
      throw new Error(`Unsafe release filename from peer: ${release.filename}`)

    const destPath = join(this.config.completedPath, safeName)
    const partPath = `${destPath}.part`

    if (this.active.has(destPath) || this.coordinator?.isPathDeleting(resolve(destPath))) {
      logger.debug({ torrentFilename, destPath }, 'A download for this destination is already active; skipping duplicate')
      return { kind: 'duplicate' }
    }

    const created = this.downloadsRepository?.create({
      torrentFilename,
      peerId,
      peerName: peer.name ?? peer.url,
      itemId,
      filename: safeName,
      destPath,
      partPath,
      releaseSize: release.size,
      release,
      qbCategory: input.qbCategory ?? null,
      qbSourceServer: input.qbSourceServer ?? null,
      sourceServerId: input.sourceServerId ?? null,
      importMode: input.importMode ?? null,
      importTarget: input.importTarget ?? null,
    })

    return {
      kind: 'created',
      record: created ?? {
        id: -1,
        torrentFilename,
        peerId,
        peerName: peer.name ?? peer.url,
        itemId,
        filename: safeName,
        destPath,
        partPath,
        releaseSize: release.size,
        release,
        expectedBytes: null,
        expectedBytesSource: null,
        expectedBytesMismatch: false,
        downloadedBytes: 0,
        attempts: 0,
        status: 'downloading',
        startedAt: '',
        updatedAt: '',
        completedAt: null,
        error: null,
        lastOperation: 'transfer',
        operationFailed: false,
        qbCategory: input.qbCategory ?? null,
        qbSourceServer: input.qbSourceServer ?? null,
        sourceServerId: input.sourceServerId ?? null,
        importMode: input.importMode ?? null,
        importTarget: input.importTarget ?? null,
        manualImportCommandId: null,
      },
    }
  }

  /**
   * qB `/api/v2/torrents/add` entrypoint: create the row and drive the download
   * in the background (the HTTP handler returns immediately).
   */
  async startQbDownload(input: {
    peerId: string
    itemId: string
    qbCategory: string
    qbSourceServer: string
    sourceServerId: string
  }): Promise<StartQbDownloadResult> {
    // qB-added downloads have no on-disk stub, but createDownload + the row still
    // need a stable filename.
    const torrentFilename = `qb-${input.peerId}-${input.itemId}.torrent`.replace(UNSAFE_FILENAME_CHARS, '_')
    let outcome: CreateDownloadOutcome
    try {
      outcome = await this.createDownload({ ...input, torrentFilename })
    }
    catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      logger.error({ peerId: input.peerId, itemId: input.itemId, error: message }, 'Failed to create qB download')
      return 'failed'
    }
    if (outcome.kind === 'no-peer')
      return 'failed'
    // A duplicate is already in flight: no new row, but a success — don't make *arr retry.
    if (outcome.kind === 'duplicate')
      return 'duplicate'
    void this.enqueue(outcome.record).catch((err) => {
      const message = err instanceof Error ? err.message : String(err)
      logger.error({ itemId: input.itemId, error: message }, 'qB download failed')
    })
    return 'started'
  }

  /**
   * Catalog direct-download entrypoint: create a jack_manual row bound to a
   * destination *arr + import target, then drive the download in the background.
   * Import is pushed later by the ImportWatcher.
   */
  async startDirectDownload(input: {
    peerId: string
    itemId: string
    destinationServerName: string
    destinationServerId: string
    importTarget: ManualImportTarget
  }): Promise<StartQbDownloadResult> {
    const torrentFilename = `direct-${input.peerId}-${input.itemId}.torrent`.replace(UNSAFE_FILENAME_CHARS, '_')
    let outcome: CreateDownloadOutcome
    try {
      outcome = await this.createDownload({
        peerId: input.peerId,
        itemId: input.itemId,
        torrentFilename,
        qbSourceServer: input.destinationServerName,
        sourceServerId: input.destinationServerId,
        importMode: 'jack_manual',
        importTarget: input.importTarget,
      })
    }
    catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      logger.error({ peerId: input.peerId, itemId: input.itemId, error: message }, 'Failed to create direct download')
      return 'failed'
    }
    if (outcome.kind === 'no-peer')
      return 'failed'
    if (outcome.kind === 'duplicate')
      return 'duplicate'
    void this.enqueue(outcome.record).catch((err) => {
      const message = err instanceof Error ? err.message : String(err)
      logger.error({ itemId: input.itemId, error: message }, 'Direct download failed')
    })
    return 'started'
  }

  /** Re-drive stale `downloading` rows from a prior run, resuming from their .part files. */
  async resumeStaleDownloads(): Promise<number> {
    const repo = this.downloadsRepository
    if (!repo)
      return 0
    // Dedupe by destPath: a prior run could leave more than one stale row for the
    // same destination (they share the same .part), but only one can be resumed.
    // Re-driving two would make the second silently early-return in runDownload
    // and stay stuck in `downloading`, so mark the superseded ones failed instead.
    const seen = new Set<string>()
    const resumable: DownloadRecord[] = []
    for (const record of repo.listStaleDownloads()) {
      if (seen.has(record.destPath)) {
        repo.markFailed(record.id, 'superseded by another resumable download for the same destination')
        continue
      }
      seen.add(record.destPath)
      resumable.push(record)
    }
    for (const record of resumable) {
      // Fire-and-forget: the semaphore caps concurrency.
      void this.enqueue(record).catch((err) => {
        const message = err instanceof Error ? err.message : String(err)
        logger.error({ torrentFilename: record.torrentFilename, error: message }, 'Failed to resume stale download')
      })
    }
    if (resumable.length > 0)
      logger.info({ downloads: resumable.length }, 'Re-enqueued interrupted downloads')
    return resumable.length
  }

  private enqueue(record: DownloadRecord): Promise<void> {
    const controller = new AbortController()
    const task = this.runDownload(record, controller)
    this.transfers.set(record.id, { controller, task })
    void task.finally(() => {
      if (this.transfers.get(record.id)?.task === task)
        this.transfers.delete(record.id)
    }).catch(() => {})
    return task
  }

  async cancel(id: number): Promise<DownloadRecord> {
    const repo = this.requireRepository()
    const record = repo.get(id)
    if (!record)
      throw new NotFoundError(`Download ${id} not found`)
    if (record.status === 'failed' && record.operationFailed && record.lastOperation === 'transfer' && record.error?.includes('cancelled'))
      return record
    if (record.status !== 'downloading')
      throw new ConflictError(`Download ${id} is not active`)
    const transfer = this.transfers.get(id)
    if (!transfer)
      throw new ConflictError(`Download ${id} is not active in this process`)
    transfer.controller.abort(new Error('Download cancelled by user'))
    await transfer.task
    return repo.get(id) ?? record
  }

  retry(id: number): DownloadRecord {
    const repo = this.requireRepository()
    const record = repo.get(id)
    if (!record)
      throw new NotFoundError(`Download ${id} not found`)
    if (!record.operationFailed || record.lastOperation !== 'transfer')
      throw new ConflictError(`Download ${id} has no failed transfer to retry`)
    if (this.coordinator?.isPathDeleting(resolve(record.destPath)))
      throw new ConflictError(`Download ${id} is being deleted`)
    if (this.transfers.has(id) || this.active.has(record.destPath))
      throw new ConflictError(`Download ${id} is already active`)
    repo.markTransferStarted(id)
    void this.enqueue(record).catch((err) => {
      const message = err instanceof Error ? err.message : String(err)
      logger.error({ id, error: message }, 'Retried download failed')
    })
    return repo.get(id) ?? record
  }

  async delete(id: number): Promise<void> {
    const repo = this.requireRepository()
    const record = repo.get(id)
    if (!record)
      throw new NotFoundError(`Download ${id} not found`)
    const paths = [resolve(record.partPath), resolve(record.destPath)]
    const operation = async () => {
      const current = repo.get(id)
      if (!current)
        throw new NotFoundError(`Download ${id} not found`)
      if (current.status === 'downloading')
        await this.cancel(id)

      // unlinkDownloadArtifact re-reads ownership immediately before each unlink. A
      // sibling that began before the path reservation was installed must keep the
      // shared file.
      for (const artifact of [record.partPath, record.destPath])
        await unlinkDownloadArtifact(repo, id, artifact, this.config.completedPath)
      repo.delete(id)
    }
    if (this.coordinator)
      await this.coordinator.runDelete(id, paths, operation)
    else
      await operation()
  }

  private async runDownload(record: DownloadRecord, controller: AbortController): Promise<void> {
    if (this.active.has(record.destPath))
      return
    this.active.add(record.destPath)
    try {
      await this.semaphore.run(() => this.downloadWithRetry(record, controller.signal), controller.signal)
    }
    catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.downloadsRepository?.markFailed(record.id, message, 'transfer')
    }
    finally {
      this.active.delete(record.destPath)
    }
  }

  private async downloadWithRetry(record: DownloadRecord, signal: AbortSignal): Promise<void> {
    const repo = this.downloadsRepository
    const peer = this.peers.find(p => p.id === record.peerId)
    if (!peer) {
      repo?.markFailed(record.id, `Peer ${record.peerId} not found`)
      logger.error({ torrentFilename: record.torrentFilename, peerId: record.peerId }, 'Cannot run download: peer not found')
      return
    }

    const onProgress = async (event: PeerDownloadProgressEvent) => {
      if (event.type === 'headers') {
        repo?.setExpectedBytes(record.id, event.expectedBytes, event.expectedBytesSource, event.expectedBytesMismatch)
        return
      }
      if (event.type === 'progress') {
        repo?.updateProgress(record.id, event.downloadedBytes)
        return
      }
      if (event.type === 'restart') {
        repo?.markResumeReset(record.id)
        return
      }
      // event.type === 'completed': the transfer finished. Record the final byte
      // count; the status flips to import_queued once downloadFile resolves below.
      repo?.updateProgress(record.id, event.downloadedBytes)
    }

    try {
      await retry(async () => {
        signal.throwIfAborted()
        repo?.incrementAttempts(record.id)
        await peer.downloadFile(record.itemId, record.destPath, {
          torrentFilename: record.torrentFilename,
          partPath: record.partPath,
          releaseSize: record.releaseSize,
          idleTimeoutMs: this.config.idleTimeoutMs,
          onProgress,
          signal,
        })
      }, {
        maxAttempts: this.config.maxDownloadAttempts,
        baseDelayMs: this.config.retryBaseDelayMs,
        maxDelayMs: this.config.retryMaxDelayMs,
        isRetryable: isTransientDownloadError,
        retryAfterMs: downloadRetryAfterMs,
        onRetry: ({ attempt, delayMs, error }) => {
          const message = error instanceof Error ? error.message : String(error)
          logger.warn({ torrentFilename: record.torrentFilename, attempt, delayMs, error: message }, 'Retrying peer download after transient failure')
        },
        signal,
      })

      signal.throwIfAborted()
      repo?.markImportQueued(record.id)
      logger.info({ torrentFilename: record.torrentFilename, filename: record.filename }, 'Download complete')
    }
    catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      // The .part file is preserved by downloadFile on failure, so a later
      // restart re-enqueue can resume from it.
      repo?.markFailed(record.id, message)
      logger.error({ torrentFilename: record.torrentFilename, filename: record.filename, error: message }, 'Download failed')
    }
  }
}
