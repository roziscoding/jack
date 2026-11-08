import type { AppDatabase } from '../../database/connection'
import type { NewUploadRow, UploadRow, UploadStatus } from '../../database/schema'
import { desc, eq } from 'drizzle-orm'
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

  create(input: CreateUploadInput): UploadRecord {
    const timestamp = nowIso()
    const values: NewUploadRow = {
      ...input,
      sentBytes: 0,
      status: 'uploading',
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

  updateProgress(id: number, sentBytes: number): void {
    this.db.update(uploads)
      .set({
        sentBytes,
        updatedAt: nowIso(),
      })
      .where(eq(uploads.id, id))
      .run()
    this.notifyChanged()
  }

  finish(id: number, status: Exclude<UploadStatus, 'uploading'>, sentBytes: number, error: string | null = null): void {
    const timestamp = nowIso()
    this.db.update(uploads)
      .set({
        status,
        sentBytes,
        error,
        updatedAt: timestamp,
        finishedAt: timestamp,
      })
      .where(eq(uploads.id, id))
      .run()
    this.notifyChanged()
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
