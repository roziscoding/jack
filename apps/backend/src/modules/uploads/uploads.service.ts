import type { CreateUploadInput, UploadRecord, UploadsRepository } from './uploads.repository'

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
   */
  start(input: CreateUploadInput, expectsReceipt: boolean, signal?: AbortSignal): number {
    const upload = this.repository.create(input, expectsReceipt ? 'uploading' : 'unconfirmed')
    // Bun aborts the request signal only when the peer disconnects before the
    // whole body went out; a finished response never fires it.
    signal?.addEventListener('abort', () => this.repository.markAborted(upload.id, 'peer disconnected'), { once: true })
    return upload.id
  }

  receipt(id: number, peerName: string, sentBytes: number, durationMs: number): boolean {
    return this.repository.complete(id, peerName, sentBytes, durationMs)
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
