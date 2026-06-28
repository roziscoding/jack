import { sql } from 'drizzle-orm'
import { check, index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'

// Lifecycle: downloading → import_queued (file in completedPath, handed to *arr)
// → imported (*arr finished importing; terminal). `failed` is terminal too.
export const DOWNLOAD_STATUSES = ['downloading', 'import_queued', 'imported', 'failed'] as const
export type DownloadStatus = typeof DOWNLOAD_STATUSES[number]
export type ExpectedBytesSource = 'content_length' | 'content_range' | 'release_size'

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
  sourceServerId: text('source_server_id'),
  // Direct catalog downloads: 'jack_manual' means the import watcher must push an
  // explicit *arr ManualImport (vs. null = qB/blackhole, where *arr imports itself).
  importMode: text('import_mode').$type<'jack_manual' | null>(),
  // JSON ManualImportTarget: {"kind":"movie","movieId":N} | {"kind":"series","seriesId":N}.
  importTarget: text('import_target'),
  manualImportCommandId: integer('manual_import_command_id'),
}, t => [
  check('downloads_status_check', sql`${t.status} in ('downloading', 'import_queued', 'imported', 'failed')`),
  check('downloads_expected_bytes_source_check', sql`${t.expectedBytesSource} is null or ${t.expectedBytesSource} in ('content_length', 'content_range', 'release_size')`),
  index('downloads_status_idx').on(t.status),
  index('downloads_updated_at_idx').on(t.updatedAt),
])

export type DownloadRow = typeof downloads.$inferSelect
export type NewDownloadRow = typeof downloads.$inferInsert

export const apiKeys = sqliteTable('api_keys', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  // .unique() already creates a unique index on key_hash, which the planner uses
  // for every findByHash lookup — no separate index needed.
  keyHash: text('key_hash').notNull().unique(),
  name: text('name'),
  description: text('description'),
  expiresAt: text('expires_at'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
})

export type ApiKeyRow = typeof apiKeys.$inferSelect
export type NewApiKeyRow = typeof apiKeys.$inferInsert

export const managedKeys = sqliteTable('managed_keys', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  keyHash: text('key_hash').notNull().unique(),
  // The destination connector id this key was provisioned for. NOT unique: an old
  // and a new row coexist briefly mid-rotation.
  serverId: text('server_id').notNull(),
  createdAt: text('created_at').notNull(),
})

export type ManagedKeyRow = typeof managedKeys.$inferSelect
export type NewManagedKeyRow = typeof managedKeys.$inferInsert
