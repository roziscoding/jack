import type { FileSystemErrorDetails } from '../lib/errors/FileSystemError'
import type { PeerCatalogTitle } from '../lib/peer-catalog'
import type { Release } from '../lib/release'
import type { TmdbMetadata } from '../lib/tmdb/client'
import { sql } from 'drizzle-orm'
import { check, index, integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core'

// Lifecycle: downloading → import_queued (file in completedPath, handed to *arr)
// → imported (*arr finished importing; terminal). `failed` is terminal too.
export const DOWNLOAD_STATUSES = [
  'downloading',
  'import_queued',
  'imported',
  'failed',
] as const
export type DownloadStatus = typeof DOWNLOAD_STATUSES[number]
export type ExpectedBytesSource = 'content_length' | 'content_range' | 'release_size'
export type DownloadOperation = 'transfer' | 'import'

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
  // A DownloadErrorCode (download-error-codes.ts). No check constraint, so new
  // codes don't need a migration.
  errorCode: text('error_code'),
  // FileSystemErrorDetails for filesystem failures, so the UI can show the
  // paths, permissions, and free space jack found. Null for other errors.
  errorDetails: text('error_details', { mode: 'json' }).$type<FileSystemErrorDetails | null>(),
  lastOperation: text('last_operation').$type<DownloadOperation>().notNull().default('transfer'),
  operationFailed: integer('operation_failed', { mode: 'boolean' }).notNull().default(false),
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
  check('downloads_last_operation_check', sql`${t.lastOperation} in ('transfer', 'import')`),
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

// One row per title per peer: a summary of what that peer carries, never the
// individual releases (a series would otherwise be one row per episode). Rows
// are diffed against each live fetch, so unchanged titles are never rewritten.
export const peerCatalogTitles = sqliteTable('peer_catalog_titles', {
  peerId: text('peer_id').notNull(),
  // The per-peer grouping key: `${mediaType}:id:${id}` or `${mediaType}:name:${name}`.
  titleKey: text('title_key').notNull(),
  mediaType: text('media_type', {
    enum: ['movie', 'tv'],
  }).notNull(),
  tmdbId: integer('tmdb_id'),
  imdbId: text('imdb_id'),
  tvdbId: integer('tvdb_id'),
  title: text('title').notNull(),
  releaseCount: integer('release_count').notNull(),
  totalSize: integer('total_size').notNull(),
  // Distinct resolutions (e.g. [2160, 1080]), best first.
  resolutions: text('resolutions', { mode: 'json' }).$type<number[]>().notNull(),
  // From the peer's *arr; null for peers older than protocol 0.2.0.
  posterUrl: text('poster_url'),
  backdropUrl: text('backdrop_url'),
  genres: text('genres', { mode: 'json' }).$type<string[]>(),
  updatedAt: text('updated_at').notNull(),
}, t => [
  primaryKey({
    columns: [t.peerId, t.titleKey],
  }),
  check('peer_catalog_titles_media_type_check', sql`${t.mediaType} in ('movie', 'tv')`),
])

export type PeerCatalogTitleRow = typeof peerCatalogTitles.$inferSelect
export type NewPeerCatalogTitleRow = typeof peerCatalogTitles.$inferInsert

// The last revision of each peer's catalog this instance has applied, so the
// next sync asks that peer only for what changed since.
export const peerCatalogSync = sqliteTable('peer_catalog_sync', {
  peerId: text('peer_id').primaryKey(),
  // Null for peers older than protocol 0.2.0, which only serve full catalogs.
  revision: integer('revision'),
  // The peer's catalog generation that revision belongs to (see ownCatalogMeta).
  generation: text('generation'),
  syncedAt: text('synced_at').notNull(),
})

// A single row naming this instance's catalog generation: a random id created
// with the database. Revisions only compare within one generation, so a peer
// holding a revision from before a database reset gets the whole catalog.
export const ownCatalogMeta = sqliteTable('own_catalog_meta', {
  id: integer('id').primaryKey(),
  generation: text('generation').notNull(),
})

// When each source was last read successfully. `/peer/search` answers from the
// cache only once every enabled source has a row here; until then it asks the
// sources directly. A source read as empty is a real answer.
export const ownCatalogSourceReads = sqliteTable('own_catalog_source_reads', {
  sourceId: text('source_id').primaryKey(),
  readAt: text('read_at').notNull(),
})

// Each source's own titles as of its last successful read. The served catalog
// (ownCatalogTitles) is merged from the rows of the sources that are enabled
// now, so a source that fails keeps its titles and a disabled one drops them.
export const ownCatalogSourceTitles = sqliteTable('own_catalog_source_titles', {
  sourceId: text('source_id').notNull(),
  titleKey: text('title_key').notNull(),
  data: text('data', { mode: 'json' }).$type<PeerCatalogTitle>().notNull(),
}, t => [
  primaryKey({
    columns: [t.sourceId, t.titleKey],
  }),
])

// This instance's own catalog as served to peers, rebuilt from the source
// Radarr/Sonarr on each sync. Every change stamps the row with the next
// revision; removed titles stay as `deleted` rows so a peer asking for changes
// since an older revision learns about the removal.
export const ownCatalogTitles = sqliteTable('own_catalog_titles', {
  titleKey: text('title_key').primaryKey(),
  mediaType: text('media_type', {
    enum: ['movie', 'tv'],
  }).notNull(),
  tmdbId: integer('tmdb_id'),
  imdbId: text('imdb_id'),
  tvdbId: integer('tvdb_id'),
  title: text('title').notNull(),
  releaseCount: integer('release_count').notNull(),
  totalSize: integer('total_size').notNull(),
  resolutions: text('resolutions', { mode: 'json' }).$type<number[]>().notNull(),
  posterUrl: text('poster_url'),
  backdropUrl: text('backdrop_url'),
  genres: text('genres', { mode: 'json' }).$type<string[]>(),
  revision: integer('revision').notNull(),
  deleted: integer('deleted', { mode: 'boolean' }).notNull().default(false),
}, t => [
  check('own_catalog_titles_media_type_check', sql`${t.mediaType} in ('movie', 'tv')`),
  index('own_catalog_titles_revision_idx').on(t.revision),
])

export type OwnCatalogTitleRow = typeof ownCatalogTitles.$inferSelect

// The releases behind each own catalog title, so `/peer/search` is answered from
// here instead of Radarr/Sonarr. Ids are the *arr release ids, so a peer can
// still fetch the item and its file live.
export const ownCatalogReleases = sqliteTable('own_catalog_releases', {
  id: text('id').primaryKey(),
  // The source connector that holds the file.
  sourceId: text('source_id').notNull(),
  titleKey: text('title_key').notNull(),
  mediaType: text('media_type', {
    enum: ['movie', 'tv'],
  }).notNull(),
  tmdbId: integer('tmdb_id'),
  // Without the `tt` prefix, the form peers search with.
  imdbId: text('imdb_id'),
  tvdbId: integer('tvdb_id'),
  season: integer('season'),
  episode: integer('episode'),
  // The Release as the source returned it.
  data: text('data', { mode: 'json' }).$type<Release>().notNull(),
}, t => [
  check('own_catalog_releases_media_type_check', sql`${t.mediaType} in ('movie', 'tv')`),
  index('own_catalog_releases_source_id_idx').on(t.sourceId),
  index('own_catalog_releases_title_key_idx').on(t.titleKey),
  index('own_catalog_releases_tmdb_id_idx').on(t.tmdbId),
  index('own_catalog_releases_imdb_id_idx').on(t.imdbId),
  index('own_catalog_releases_tvdb_id_idx').on(t.tvdbId),
])

export type OwnCatalogReleaseRow = typeof ownCatalogReleases.$inferSelect

// TMDB lookups, persisted so a title is looked up once. `data` is null when TMDB
// has no entry for the id (404); failed lookups are not stored and retry.
export const tmdbMetadata = sqliteTable('tmdb_metadata', {
  mediaType: text('media_type', {
    enum: ['movie', 'tv'],
  }).notNull(),
  tmdbId: integer('tmdb_id').notNull(),
  data: text('data', { mode: 'json' }).$type<TmdbMetadata | null>(),
  fetchedAt: text('fetched_at').notNull(),
}, t => [
  primaryKey({
    columns: [t.mediaType, t.tmdbId],
  }),
  check('tmdb_metadata_media_type_check', sql`${t.mediaType} in ('movie', 'tv')`),
])

export type TmdbMetadataRow = typeof tmdbMetadata.$inferSelect
