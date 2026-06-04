import type { AppDatabase } from '../../database/connection'
import type { DownloadRow, DownloadStatus, ExpectedBytesSource, NewDownloadRow } from '../../database/schema'
import type { Release } from '../../lib/release'
import { desc, eq } from 'drizzle-orm'
import { downloads } from '../../database/schema'

export interface DownloadRecord {
  id: number
  torrentFilename: string
  peerId: string
  peerName: string
  itemId: string
  filename: string
  destPath: string
  partPath: string
  releaseSize: number
  release: Release
  expectedBytes: number | null
  expectedBytesSource: ExpectedBytesSource | null
  expectedBytesMismatch: boolean
  downloadedBytes: number
  status: DownloadStatus
  startedAt: string
  updatedAt: string
  completedAt: string | null
  error: string | null
}

export interface CreateDownloadInput {
  torrentFilename: string
  peerId: string
  peerName: string
  itemId: string
  filename: string
  destPath: string
  partPath: string
  releaseSize: number
  release: Release
}

function nowIso() {
  return new Date().toISOString()
}

function toRecord(row: DownloadRow): DownloadRecord {
  return {
    id: row.id,
    torrentFilename: row.torrentFilename,
    peerId: row.peerId,
    peerName: row.peerName,
    itemId: row.itemId,
    filename: row.filename,
    destPath: row.destPath,
    partPath: row.partPath,
    releaseSize: row.releaseSize,
    release: JSON.parse(row.releaseJson) as Release,
    expectedBytes: row.expectedBytes,
    expectedBytesSource: row.expectedBytesSource ?? null,
    expectedBytesMismatch: row.expectedBytesMismatch,
    downloadedBytes: row.downloadedBytes,
    status: row.status,
    startedAt: row.startedAt,
    updatedAt: row.updatedAt,
    completedAt: row.completedAt,
    error: row.error,
  }
}

export class DownloadsRepository {
  constructor(private readonly db: AppDatabase) {}

  create(input: CreateDownloadInput): DownloadRecord {
    const timestamp = nowIso()
    const values: NewDownloadRow = {
      torrentFilename: input.torrentFilename,
      peerId: input.peerId,
      peerName: input.peerName,
      itemId: input.itemId,
      filename: input.filename,
      destPath: input.destPath,
      partPath: input.partPath,
      releaseSize: input.releaseSize,
      releaseJson: JSON.stringify(input.release),
      downloadedBytes: 0,
      status: 'downloading',
      startedAt: timestamp,
      updatedAt: timestamp,
    }

    const row = this.db.insert(downloads).values(values).returning().get()
    return toRecord(row)
  }

  get(id: number): DownloadRecord | null {
    const row = this.db.select().from(downloads).where(eq(downloads.id, id)).get()
    return row ? toRecord(row) : null
  }

  list(): DownloadRecord[] {
    // Secondary sort by id breaks ties when two rows share an updatedAt
    // (ISO timestamps can collide within the same millisecond).
    return this.db.select().from(downloads).orderBy(desc(downloads.updatedAt), desc(downloads.id)).all().map(toRecord)
  }

  setExpectedBytes(id: number, expectedBytes: number | null, source: ExpectedBytesSource | null, mismatch = false): void {
    this.db.update(downloads)
      .set({ expectedBytes, expectedBytesSource: source, expectedBytesMismatch: mismatch, updatedAt: nowIso() })
      .where(eq(downloads.id, id))
      .run()
  }

  updateProgress(id: number, downloadedBytes: number): void {
    this.db.update(downloads)
      .set({ downloadedBytes, updatedAt: nowIso() })
      .where(eq(downloads.id, id))
      .run()
  }

  markCompleted(id: number, downloadedBytes: number): void {
    const timestamp = nowIso()
    this.db.update(downloads)
      .set({ status: 'completed', downloadedBytes, completedAt: timestamp, updatedAt: timestamp, error: null })
      .where(eq(downloads.id, id))
      .run()
  }

  markImportQueued(id: number): void {
    this.db.update(downloads)
      .set({ status: 'import_queued', updatedAt: nowIso() })
      .where(eq(downloads.id, id))
      .run()
  }

  markFailed(id: number, error: string): void {
    this.db.update(downloads)
      .set({ status: 'failed', error, updatedAt: nowIso() })
      .where(eq(downloads.id, id))
      .run()
  }

  async reconcileStaleDownloads(): Promise<number> {
    const staleRows = this.db.select().from(downloads).where(eq(downloads.status, 'downloading')).all()

    for (const row of staleRows) {
      const partFile = Bun.file(row.partPath)
      const partExists = await partFile.exists()
      const downloadedBytes = partExists ? partFile.size : row.downloadedBytes
      this.db.update(downloads)
        .set({
          status: 'failed',
          downloadedBytes,
          error: partExists
            ? `stale download after Jack restart; found .part file with ${downloadedBytes} bytes`
            : 'stale download after Jack restart; .part file was not found',
          updatedAt: nowIso(),
        })
        .where(eq(downloads.id, row.id))
        .run()
    }

    return staleRows.length
  }
}
