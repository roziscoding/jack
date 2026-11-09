import type { AppDatabase } from '../../database/connection'
import type { UploadRow, UploadStatus } from '../../database/schema'
import { and, count, desc, eq, inArray, isNotNull, isNull, lt, sql, sum } from 'drizzle-orm'
import { UPLOAD_STATUSES, uploads } from '../../database/schema'

export type UploadRecord = UploadRow

// A transfer can still be resumed and completed; a late receipt revives an expired one.
const OPEN = ['uploading', 'unconfirmed'] as const

export interface CreateTransferInput {
  peerName: string
  peerKeyId: number | null
  itemId: string
  filename: string
  totalBytes: number
  clientTransferId: string
}

function nowIso() {
  return new Date().toISOString()
}

/** Rows a key owns: only its own api key (null for the master key) may use a transfer. */
function ownedBy(peerKeyId: number | null) {
  return peerKeyId === null
    ? isNull(uploads.peerKeyId)
    : eq(uploads.peerKeyId, peerKeyId)
}

/**
 * Files peers pull from this instance, one row per transfer. Rows are kept after
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

  /**
   * Creates the transfer, or returns the one this key already created with the
   * same client transfer id. `created` is false for the latter.
   */
  create(input: CreateTransferInput): { upload: UploadRecord, created: boolean } {
    const { clientTransferId, ...row } = input
    const idempotencyKey = `${input.peerKeyId ?? 'master'}:${clientTransferId}`
    const timestamp = nowIso()
    const inserted = this.db.insert(uploads)
      .values({
        ...row,
        transferId: crypto.randomUUID(),
        idempotencyKey,
        status: 'uploading',
        startedAt: timestamp,
        updatedAt: timestamp,
      })
      .onConflictDoNothing({ target: uploads.idempotencyKey })
      .returning()
      .get()
    if (inserted) {
      this.notifyChanged()
      return { upload: inserted, created: true }
    }
    const existing = this.db.select().from(uploads).where(eq(uploads.idempotencyKey, idempotencyKey)).get()!
    return { upload: existing, created: false }
  }

  get(id: number): UploadRecord | null {
    return this.db.select().from(uploads).where(eq(uploads.id, id)).get() ?? null
  }

  /** The transfer behind a `downloadId`, if this key owns it. */
  findOwned(transferId: string, peerKeyId: number | null): UploadRecord | null {
    return this.db.select().from(uploads).where(and(eq(uploads.transferId, transferId), ownedBy(peerKeyId))).get() ?? null
  }

  /** Totals for the dashboard, counted in SQLite so the history is never loaded. */
  summary(): { byStatus: Record<UploadStatus, number>, total: number, bytesSent: number } {
    const rows = this.db.select({
      status: uploads.status,
      count: count(),
      bytes: sum(uploads.sentBytes),
    })
      .from(uploads)
      .groupBy(uploads.status)
      .all()
    const byStatus = Object.fromEntries(UPLOAD_STATUSES.map(s => [s, 0])) as Record<UploadStatus, number>
    let total = 0
    let bytesSent = 0
    for (const row of rows) {
      byStatus[row.status] = row.count
      total += row.count
      bytesSent += Number(row.bytes ?? 0)
    }
    return { byStatus, total, bytesSent }
  }

  /** Transfers still open, newest first. */
  listActive(): UploadRecord[] {
    return this.db.select().from(uploads).where(eq(uploads.status, 'uploading')).orderBy(desc(uploads.startedAt), desc(uploads.id)).all()
  }

  /** Newest first; the id breaks ties between rows started in the same millisecond. */
  list(): UploadRecord[] {
    return this.db.select().from(uploads).orderBy(desc(uploads.startedAt), desc(uploads.id)).all()
  }

  /** A request for the file starting at byte `start`; keeps the lowest one seen. */
  served(id: number, start: number): void {
    this.db.update(uploads)
      .set({
        rangeStart: sql`min(coalesce(${uploads.rangeStart}, ${start}), ${start})`,
        updatedAt: nowIso(),
      })
      .where(and(eq(uploads.id, id), inArray(uploads.status, [...OPEN])))
      .run()
    this.notifyChanged()
  }

  /**
   * The downloading peer's receipt: the whole file arrived. Only the owning key
   * can close a transfer, only while it is open, and only once the file was
   * requested. The bytes and time come from what jack served, so a peer can't
   * skew the totals. Returns whether the row was updated.
   */
  complete(transferId: string, peerKeyId: number | null, now = Date.now()): boolean {
    const changed = this.db.update(uploads)
      .set({
        status: 'completed',
        sentBytes: sql`${uploads.totalBytes} - ${uploads.rangeStart}`,
        durationMs: sql`max(0, ${now} - cast(round(unixepoch(${uploads.startedAt}, 'subsec') * 1000) as integer))`,
        updatedAt: new Date(now).toISOString(),
        finishedAt: new Date(now).toISOString(),
      })
      .where(and(eq(uploads.transferId, transferId), ownedBy(peerKeyId), inArray(uploads.status, [...OPEN]), isNotNull(uploads.rangeStart)))
      .returning({ id: uploads.id })
      .all()
    if (changed.length > 0)
      this.notifyChanged()
    return changed.length > 0
  }

  /** Transfers still open that started before `before`: their receipt isn't coming. */
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
}
