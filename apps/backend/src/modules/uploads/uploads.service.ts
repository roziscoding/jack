import type { CreateUploadInput, UploadRecord, UploadsRepository } from './uploads.repository'
import { logger } from '../../logger'

// A receipt that hasn't come after this long won't: the row goes `unconfirmed`.
const RECEIPT_WAIT_MS = 48 * 60 * 60 * 1000

/**
 * Records files peers pull from `/peer/items/:id/file`. The file itself is sent
 * zero-copy, untouched; this only keeps the row. A disconnect marks it aborted,
 * and the downloading jack's receipt (`/peer/uploads/:id/receipt`) completes it
 * with the bytes and time the transfer took.
 */
export class UploadsService {
  constructor(readonly repository: UploadsRepository) {}

  /**
   * Starts a row for this request and returns its id, for the `X-Jack-Upload-Id`
   * response header. `expectsReceipt` is whether the peer said it will report back.
   *
   * Returns undefined when the row can't be written (e.g. the database disk is
   * full): the file is still served, just untracked. Bookkeeping never fails a
   * transfer.
   */
  start(input: CreateUploadInput, expectsReceipt: boolean, signal?: AbortSignal): number | undefined {
    try {
      const upload = this.repository.create(input, expectsReceipt ? 'uploading' : 'unconfirmed')
      const abort = () => this.repository.markAborted(upload.id, 'peer disconnected')
      // The peer may have left while jack was looking up the file, and a listener
      // added now would never fire.
      if (signal?.aborted)
        abort()
      // Bun aborts the request signal only when the peer disconnects before the
      // whole body went out; a finished response never fires it.
      else
        signal?.addEventListener('abort', abort, { once: true })
      return upload.id
    }
    catch (err) {
      logger.warn({ itemId: input.itemId, peer: input.peerName, err }, 'Could not record an upload; serving it untracked')
      return undefined
    }
  }

  receipt(id: number, peerKeyId: number | null, sentBytes: number, durationMs: number): boolean {
    return this.repository.complete(id, peerKeyId, sentBytes, durationMs)
  }

  expireUnconfirmed(now = Date.now()): number {
    return this.repository.expireUnconfirmed(new Date(now - RECEIPT_WAIT_MS).toISOString())
  }

  list(): UploadRecord[] {
    return this.repository.list()
  }

  subscribe(subscriber: () => void): () => void {
    return this.repository.subscribe(subscriber)
  }
}
