import type { AppDatabase } from '../../database/connection'
import type { NewUploadRow, UploadRow } from '../../database/schema'
import { and, desc, eq, inArray, lt } from 'drizzle-orm'
import { uploads } from '../../database/schema'

export type UploadRecord = UploadRow

export interface CreateUploadInput {
  peerName: string
  itemId: string
  filename: string
  totalBytes: number
  rangeStart: number
  requestedBytes: number
}

// Statuses an upload can still leave: a receipt or a disconnect may yet arrive.
const OPEN = ['uploading', 'unconfirmed'] as const

function nowIso() {
  return new Date().toISOString()
}

/**
 * Files peers pull from this instance, one row per request. Rows are kept after
 * they finish so the list doubles as a history.
 */
export class UploadsRepository {
  private readonly subscribers = new Set<() => void>()

  constructor(private readonly db: AppDatabase) {}

  subscribe(subscriber: () => void): () => void {
    this.subscribers.add(subscriber)
    return () => this.subscribers.delete(subscriber)
  }

  private notifyChanged(): void {
    for (const subscriber of this.subscribers) {
      try {
        subscriber()
      }
      catch {
        // Observers must never make a committed database mutation look failed.
      }
    }
  }

  /** `uploading` when the peer promised a receipt, `unconfirmed` when it can't send one. */
  create(input: CreateUploadInput, status: 'uploading' | 'unconfirmed'): UploadRecord {
    const timestamp = nowIso()
    const values: NewUploadRow = {
      ...input,
      sentBytes: 0,
      status,
      startedAt: timestamp,
      updatedAt: timestamp,
    }
    const row = this.db.insert(uploads).values(values).returning().get()
    this.notifyChanged()
    return row
  }

  get(id: number): UploadRecord | null {
    return this.db.select().from(uploads).where(eq(uploads.id, id)).get() ?? null
  }

  /** Newest first; the id breaks ties between rows started in the same millisecond. */
  list(): UploadRecord[] {
    return this.db.select().from(uploads).orderBy(desc(uploads.startedAt), desc(uploads.id)).all()
  }

  /** The peer disconnected before the body was sent. No-op once the row has ended. */
  markAborted(id: number, error: string): void {
    const timestamp = nowIso()
    const changed = this.db.update(uploads)
      .set({
        status: 'aborted',
        error,
        updatedAt: timestamp,
        finishedAt: timestamp,
      })
      .where(and(eq(uploads.id, id), inArray(uploads.status, [...OPEN])))
      .returning({ id: uploads.id })
      .all()
    if (changed.length > 0)
      this.notifyChanged()
  }

  /**
   * The downloading peer's receipt: it got `sentBytes` in `durationMs`. Only the
   * peer the row belongs to can close it, and only while it is still open.
   * Returns whether the row was updated.
   */
  complete(id: number, peerName: string, sentBytes: number, durationMs: number): boolean {
    const timestamp = nowIso()
    const changed = this.db.update(uploads)
      .set({
        status: 'completed',
        sentBytes,
        durationMs,
        error: null,
        updatedAt: timestamp,
        finishedAt: timestamp,
      })
      .where(and(eq(uploads.id, id), eq(uploads.peerName, peerName), inArray(uploads.status, [...OPEN])))
      .returning({ id: uploads.id })
      .all()
    if (changed.length > 0)
      this.notifyChanged()
    return changed.length > 0
  }

  /** Rows still waiting for a receipt that started before `before`: it isn't coming. */
  expireUnconfirmed(before: string): number {
    const rows = this.db.update(uploads)
      .set({
        status: 'unconfirmed',
        updatedAt: nowIso(),
      })
      .where(and(eq(uploads.status, 'uploading'), lt(uploads.startedAt, before)))
      .returning({ id: uploads.id })
      .all()
    if (rows.length > 0)
      this.notifyChanged()
    return rows.length
  }

  /** Rows still `uploading` from a previous run lost their connection with it. */
  reconcileInterrupted(): number {
    const timestamp = nowIso()
    const rows = this.db.update(uploads)
      .set({
        status: 'aborted',
        error: 'interrupted by a jack restart',
        updatedAt: timestamp,
        finishedAt: timestamp,
      })
      .where(eq(uploads.status, 'uploading'))
      .returning({ id: uploads.id })
      .all()
    if (rows.length > 0)
      this.notifyChanged()
    return rows.length
  }
}
