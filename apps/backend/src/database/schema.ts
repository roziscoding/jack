import { sql } from 'drizzle-orm'
import { check, index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'

export const DOWNLOAD_STATUSES = ['downloading', 'completed', 'failed', 'import_queued'] as const
export type DownloadStatus = typeof DOWNLOAD_STATUSES[number]
export type ExpectedBytesSource = 'content_length'

export const downloads = sqliteTable('downloads', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  torrentFilename: text('torrent_filename').notNull(),
  peerId: text('peer_id').notNull(),
  peerName: text('peer_name').notNull(),
  itemId: text('item_id').notNull(),
  filename: text('filename').notNull(),
  destPath: text('dest_path').notNull(),
  partPath: text('part_path').notNull(),
  releaseSize: integer('release_size').notNull(),
  releaseJson: text('release_json').notNull(),
  expectedBytes: integer('expected_bytes'),
  expectedBytesSource: text('expected_bytes_source').$type<ExpectedBytesSource | null>(),
  expectedBytesMismatch: integer('expected_bytes_mismatch', { mode: 'boolean' }).notNull().default(false),
  downloadedBytes: integer('downloaded_bytes').notNull().default(0),
  attempts: integer('attempts').notNull().default(0),
  status: text('status').$type<DownloadStatus>().notNull(),
  startedAt: text('started_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  completedAt: text('completed_at'),
  error: text('error'),
  // qBittorrent emulation: the category *arr sent on add, and the server
  // connector that added it. Presence of qbSourceServer marks a qB-added
  // download (→ *arr-pull import, no jack push). Null for blackhole-added rows.
  qbCategory: text('qb_category'),
  qbSourceServer: text('qb_source_server'),
}, t => [
  check('downloads_status_check', sql`${t.status} in ('downloading', 'completed', 'failed', 'import_queued')`),
  check('downloads_expected_bytes_source_check', sql`${t.expectedBytesSource} is null or ${t.expectedBytesSource} = 'content_length'`),
  index('downloads_status_idx').on(t.status),
  index('downloads_updated_at_idx').on(t.updatedAt),
])

export type DownloadRow = typeof downloads.$inferSelect
export type NewDownloadRow = typeof downloads.$inferInsert
