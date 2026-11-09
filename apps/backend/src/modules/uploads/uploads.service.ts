import type { UploadRecord, UploadsRepository } from './uploads.repository'
import { logger } from '../../logger'

// A receipt that hasn't come after this long won't: the row goes `unconfirmed`.
const RECEIPT_WAIT_MS = 48 * 60 * 60 * 1000

/**
 * Transfers peers pull from this instance. A peer creates one with
 * `POST /peer/items/:itemId/downloads`, streams it from
 * `/peer/downloads/:downloadId/file` as many times as it needs to resume, and
 * completes it with `/peer/downloads/:downloadId/receipt`. The file itself is
 * sent zero-copy, untouched; this only keeps the row.
 */
export class UploadsService {
  constructor(readonly repository: UploadsRepository) {}

  /** Called from a timer, so it never throws: a failure is logged and retried next time. */
  expireUnconfirmed(now = Date.now()): number {
    try {
      return this.repository.expireUnconfirmed(new Date(now - RECEIPT_WAIT_MS).toISOString())
    }
    catch (err) {
      logger.warn({ err }, 'Could not expire uploads waiting for a receipt')
      return 0
    }
  }

  list(): UploadRecord[] {
    return this.repository.list()
  }

  subscribe(subscriber: () => void): () => void {
    return this.repository.subscribe(subscriber)
  }
}
