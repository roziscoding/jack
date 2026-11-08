import type { CreateUploadInput, UploadRecord, UploadsRepository } from './uploads.repository'
import { logger } from '../../logger'
import { LiveProgressTracker } from '../downloads/live-progress'
import { countBytes } from './counting-stream'

// The row is written this often while a file streams (and once at the end).
const PERSIST_INTERVAL_MS = 10_000
// The live tracker gets a sample this often, enough for a smooth speed reading.
const LIVE_INTERVAL_MS = 1000

/**
 * Records files peers pull from `/peer/items/:id/file`. Each request gets an
 * `uploads` row; the bytes are counted as the peer reads them, persisted every
 * 10 s, and fed to an in-memory tracker about once a second for live speed.
 */
export class UploadsService {
  readonly live: LiveProgressTracker

  constructor(
    readonly repository: UploadsRepository,
    private readonly now: () => number = Date.now,
  ) {
    this.live = new LiveProgressTracker(now)
  }

  /** Starts a row for this request and returns the body to send instead of `body`. */
  track(input: CreateUploadInput, body: Blob, signal?: AbortSignal): ReadableStream<Uint8Array> {
    const upload = this.repository.create(input)
    let lastPersist = this.now()
    let lastSample = lastPersist
    this.live.record(upload.id, 0)

    return countBytes(body, {
      onProgress: (sentBytes) => {
        const t = this.now()
        if (t - lastSample >= LIVE_INTERVAL_MS) {
          lastSample = t
          this.live.record(upload.id, sentBytes)
        }
        if (t - lastPersist >= PERSIST_INTERVAL_MS) {
          lastPersist = t
          this.write(upload.id, () => this.repository.updateProgress(upload.id, sentBytes))
        }
      },
      onEnd: (outcome, sentBytes, error) => {
        this.live.clear(upload.id)
        this.write(upload.id, () => this.repository.finish(upload.id, outcome, sentBytes, error))
      },
    }, signal)
  }

  list(): UploadRecord[] {
    return this.repository.list()
  }

  subscribe(subscriber: () => void): () => void {
    const unsubscribers = [
      this.repository.subscribe(subscriber),
      this.live.subscribe(subscriber),
    ]
    return () => {
      for (const unsubscribe of unsubscribers)
        unsubscribe()
    }
  }

  // Bookkeeping must never break the transfer it describes.
  private write(id: number, fn: () => void): void {
    try {
      fn()
    }
    catch (err) {
      logger.warn({ uploadId: id, err }, 'Failed to record upload progress')
    }
  }
}
