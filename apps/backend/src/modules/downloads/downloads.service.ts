import type { AppConfig } from '../../lib/config'
import type { ArrServerConnector } from '../../lib/servers/arr/base'
import type { PeerConnector, PeerDownloadProgressEvent } from '../../lib/servers/peer'
import type { DownloadRecord, DownloadsRepository } from './downloads.repository'
import { Buffer } from 'node:buffer'
import { unlink } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { retry } from '../../lib/retry'
import { Semaphore } from '../../lib/semaphore'
import { withSpan } from '../../lib/tracing'
import { logger } from '../../logger'
import { parseTorrentStub } from '../torznab/torrent'
import { downloadRetryAfterMs, isTransientDownloadError } from './retry-policy'

type DownloadsServiceConfig = NonNullable<AppConfig['downloads']>

// Characters disallowed in the synthetic qB torrent filename (keep word chars, dot, dash).
const UNSAFE_FILENAME_CHARS = /[^\w.-]/g

export class DownloadsService {
  private readonly semaphore: Semaphore
  // Dest paths with a download in flight — guards two concurrent live drops that
  // resolve to the same destination (no duplicate rows / writers).
  private readonly active = new Set<string>()
  // Torrent filenames owned by the startup re-enqueue. Their leftover stubs are
  // skipped by the watcher's initial scan for the rest of the run, so a re-drive
  // that fails fast cannot be re-processed into a duplicate row.
  private readonly reenqueued = new Set<string>()

  constructor(
    private readonly config: DownloadsServiceConfig,
    private readonly peers: PeerConnector[],
    private readonly destinations: ArrServerConnector[],
    private readonly downloadsRepository?: DownloadsRepository,
  ) {
    this.semaphore = new Semaphore(config.maxConcurrentDownloads)
  }

  async processTorrentFile(filePath: string, filename: string) {
    try {
      await withSpan('blackhole.process_torrent', { 'torrent.filename': filename }, async (span) => {
        // The startup re-enqueue owns this stub — it is being (or will be)
        // re-driven from the persisted row. Skip it so we never create a
        // duplicate row, even if that re-drive already failed and cleared `active`.
        if (this.reenqueued.has(filename)) {
          span.setAttribute('torrent.reenqueued', true)
          logger.debug({ torrentFilename: filename }, 'Stub owned by startup re-enqueue; skipping watcher processing')
          return
        }

        const file = Bun.file(filePath)
        if (!await file.exists()) {
          span.setAttribute('torrent.exists', false)
          return
        }

        span.setAttribute('torrent.exists', true)
        const data = Buffer.from(await file.arrayBuffer())
        const stub = parseTorrentStub(data)

        if (!stub) {
          span.setAttribute('torrent.stub.valid', false)
          logger.warn({ torrentFilename: filename, filename }, 'Could not parse torrent stub, skipping')
          return
        }

        span.setAttribute('torrent.stub.valid', true)
        const record = await this.createDownload({
          peerId: stub.peerId,
          itemId: stub.itemId,
          torrentFilename: filename,
        })
        if (record)
          await this.runDownload(record)
      })
    }
    catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      logger.error({ torrentFilename: filename, filename, error: message }, 'Failed to process torrent')
    }
  }

  /**
   * Shared creation core for both the blackhole and qB add paths. Returns the
   * created record, or null when the peer/release is unavailable or a download
   * for the same destination is already active. Throws on an unsafe filename.
   */
  private async createDownload(input: {
    peerId: string
    itemId: string
    torrentFilename: string
    qbCategory?: string | null
    qbSourceServer?: string | null
  }): Promise<DownloadRecord | null> {
    const { peerId, itemId, torrentFilename } = input
    const peer = this.peers.find(p => p.id === peerId)
    if (!peer) {
      logger.error({ torrentFilename, peerId }, 'Peer not found')
      return null
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

    if (this.active.has(destPath)) {
      logger.debug({ torrentFilename, destPath }, 'A download for this destination is already active; skipping duplicate')
      return null
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
    })

    return created ?? {
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
      qbCategory: input.qbCategory ?? null,
      qbSourceServer: input.qbSourceServer ?? null,
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
  }): Promise<DownloadRecord | null> {
    // qB-added downloads have no on-disk stub, but createDownload + the row still
    // need a stable filename (also used by the no-op stubPath cleanup on success).
    const torrentFilename = `qb-${input.peerId}-${input.itemId}.torrent`.replace(UNSAFE_FILENAME_CHARS, '_')
    let record: DownloadRecord | null = null
    try {
      record = await this.createDownload({ ...input, torrentFilename })
    }
    catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      logger.error({ peerId: input.peerId, itemId: input.itemId, error: message }, 'Failed to create qB download')
      return null
    }
    if (record) {
      void this.runDownload(record).catch((err) => {
        const message = err instanceof Error ? err.message : String(err)
        logger.error({ itemId: input.itemId, error: message }, 'qB download failed')
      })
    }
    return record
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
    // Claim every resumable stub up-front (synchronously, before the watcher
    // starts) so the initial scan skips them regardless of re-drive timing/outcome.
    for (const record of resumable)
      this.reenqueued.add(record.torrentFilename)
    for (const record of resumable) {
      // Fire-and-forget: the semaphore caps concurrency, and the stub is already
      // claimed in `reenqueued` so the watcher won't duplicate it.
      void this.runDownload(record).catch((err) => {
        const message = err instanceof Error ? err.message : String(err)
        logger.error({ torrentFilename: record.torrentFilename, error: message }, 'Failed to resume stale download')
      })
    }
    if (resumable.length > 0)
      logger.info({ downloads: resumable.length }, 'Re-enqueued interrupted downloads')
    return resumable.length
  }

  private async runDownload(record: DownloadRecord): Promise<void> {
    if (this.active.has(record.destPath))
      return
    this.active.add(record.destPath)
    try {
      await this.semaphore.run(() => this.downloadWithRetry(record))
    }
    finally {
      this.active.delete(record.destPath)
    }
  }

  private async downloadWithRetry(record: DownloadRecord): Promise<void> {
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
      repo?.markCompleted(record.id, event.downloadedBytes)
    }

    const stubPath = join(this.config.watchPath, record.torrentFilename)

    try {
      await retry(async () => {
        repo?.incrementAttempts(record.id)
        await peer.downloadFile(record.itemId, record.destPath, {
          torrentFilename: record.torrentFilename,
          partPath: record.partPath,
          releaseSize: record.releaseSize,
          onProgress,
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
      })

      await unlink(stubPath).catch(() => {})
      // qB-added downloads are imported by *arr pulling from the reported
      // content_path; only blackhole-added downloads need the jack push.
      if (!record.qbSourceServer)
        await this.triggerImport(record)
      repo?.markImportQueued(record.id)
      // Release the startup-re-enqueue claim now that the stub is gone, so a
      // later legitimate re-drop of the same filename isn't silently skipped.
      // Only on success: a failed re-drive keeps its stub, so it stays claimed
      // (and is re-driven on the next restart) to avoid in-session hammering.
      this.reenqueued.delete(record.torrentFilename)
      logger.info({ torrentFilename: record.torrentFilename, filename: record.filename }, 'Download complete, triggered import')
    }
    catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      // The .part file is preserved by downloadFile on failure, so a later
      // restart re-enqueue can resume from it.
      repo?.markFailed(record.id, message)
      logger.error({ torrentFilename: record.torrentFilename, filename: record.filename, error: message }, 'Download failed')
    }
  }

  private async triggerImport(record: DownloadRecord) {
    const torrentFilename = record.torrentFilename
    // Route the import to the *arr that owns this release's category (movie →
    // Radarr, tv → Sonarr). Firing at every destination makes the wrong app scan
    // a folder it can't match, and Sonarr in particular answers with a 500.
    const category = record.release.category
    const matching = this.destinations.filter(d => d.isInitialized && d.canDestination && d.categories.includes(category))

    if (matching.length === 0) {
      logger.warn({ torrentFilename, category }, 'No initialized destination handles this release category; skipping import trigger')
      return
    }

    for (const dest of matching) {
      try {
        await withSpan('blackhole.trigger_import', { 'torrent.filename': torrentFilename, 'destination.name': dest.name, 'release.category': category }, async () => {
          await dest.triggerImport(this.config.completedPath)
        })
      }
      catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        logger.error({ torrentFilename, destination: dest.name, error: message }, 'Failed to trigger import')
      }
    }
  }
}
