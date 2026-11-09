export interface ConnectorBase {
  id: string
  name: string
  url: string
  type: string
  initialized: boolean
  initializationError: string | null
  // Refs-intact secrets from GET /config — present only on a deployment with a
  // ConfigService (read-only deployments omit them). Values are never resolved:
  // a `{env}`/`{file}` ref comes back as the ref, a literal as its stored string.
  apiKey?: SecretRef
  headers?: Record<string, SecretRef>
}

export interface PeerItem extends ConnectorBase {
  version: string | null
}

export interface ServerItem extends ConnectorBase {
  source: boolean
  destination: boolean
  autoregister: { enable: boolean, priority: number }
}

// The /overview endpoint returns connector items WITHOUT autoregister (that field
// only comes back on the full /config/servers payload). Keep the type honest so
// nothing reaches for a field the overview never sends.
export type OverviewServerItem = Omit<ServerItem, 'autoregister'>

// What jack found at one path when a filesystem error happened. Mirrors
// InspectedPath in apps/backend/src/lib/errors/FileSystemError.ts.
export type InspectedPath
  = | { path: string, exists: true, type: 'file' | 'directory' | 'other', mode: string, mode_octal: string, uid: number, gid: number, size_bytes?: number }
    | { path: string, exists: false, stat_error: string }

// Mirrors FileSystemErrorDetails in apps/backend/src/lib/errors/FileSystemError.ts.
export interface FileSystemErrorDetails {
  code: string
  errno: string
  explanation: string
  operation: string
  occurred_at: string
  file?: InspectedPath
  file_dir?: InspectedPath
  file_nearest_existing_dir?: InspectedPath
  destination?: InspectedPath
  destination_dir?: InspectedPath
  destination_nearest_existing_dir?: InspectedPath
  free_space?: { dir: string, bytes_available: number, inodes_free: number } | { dir: string, statfs_error: string }
  process?: { uid: number, gid: number, groups: string }
}

export interface DownloadItem {
  id: number
  filename: string
  peerName: string
  peerId: string
  status: 'downloading' | 'import_queued' | 'imported' | 'failed'
  downloadedBytes: number
  totalBytes: number | null
  progress: number | null
  // Live, while downloading: averaged over the last few seconds. Null otherwise.
  speedBps: number | null
  etaSeconds: number | null
  releaseSize: number
  attempts: number
  error: string | null
  // Why the download failed; documented at /guide/troubleshooting#<code>.
  errorCode: string | null
  // Structured context for filesystem failures; null for other errors.
  errorDetails: FileSystemErrorDetails | null
  itemId: string
  destPath: string
  partPath: string
  expectedBytesSource: 'content_length' | 'content_range' | 'release_size' | null
  // The *arr connector and category that requested it; null for catalog requests.
  qbSourceServer: string | null
  qbCategory: string | null
  lastOperation: 'transfer' | 'import'
  operationFailed: boolean
  importMode: 'jack_manual' | null
  importTarget: { kind: 'movie', movieId: number } | { kind: 'series', seriesId: number } | null
  startedAt: string
  updatedAt: string
  completedAt: string | null
  expectedBytesMismatch: boolean
}

// A file a peer pulls from this instance. One per file request: a resumed
// transfer is a new upload starting at `rangeStart`.
export interface UploadItem {
  id: number
  // The API key the peer used; 'master' for the master key.
  peerName: string
  itemId: string
  filename: string
  // The whole file's size on disk.
  totalBytes: number
  rangeStart: number
  requestedBytes: number
  // From the downloading jack's receipt; 0 until it arrives.
  sentBytes: number
  // Transfer time from the receipt; null without one.
  durationMs: number | null
  // Through the whole file, counting the range start. Null until completed.
  progress: number | null
  // Average over the whole transfer, from the receipt. Null without one.
  speedBps: number | null
  // Files go out zero-copy: `completed` needs the peer's receipt, and a peer that
  // sends none (an older jack, or a lost receipt) leaves it `unconfirmed`.
  status: 'uploading' | 'completed' | 'aborted' | 'unconfirmed'
  error: string | null
  startedAt: string
  updatedAt: string
  finishedAt: string | null
}

export interface TmdbMetadata {
  tmdbId: number
  title: string
  overview: string | null
  year: number | null
  rating: number | null
  posterUrl: string | null
  backdropUrl: string | null
  genres: string[]
}

export interface CatalogTitlePeer {
  id: string
  name: string
  releaseCount: number
  totalSize: number
  // Distinct resolutions this peer has the title in, best first.
  resolutions: number[]
}

export interface CatalogTitle {
  key: string
  mediaType: 'movie' | 'tv'
  tmdbId?: number
  imdbId?: string
  tvdbId?: number
  displayTitle: string
  // From the peers' *arr metadata: shown when TMDB has nothing (or isn't set up).
  posterUrl?: string
  backdropUrl?: string
  genres: string[]
  // Totals across every peer that carries this title.
  releaseCount: number
  totalSize: number
  // Absent until looked up; null when TMDB has no entry for the id.
  metadata?: TmdbMetadata | null
  // A local Radarr/Sonarr already has at least one file for this title.
  inLibrary: boolean
  peers: CatalogTitlePeer[]
}

export interface CatalogFacets {
  // Counts across the whole catalog, so each filter shows what it can reach.
  types: { all: number, movie: number, tv: number }
  peers: Record<string, number>
  genres: Array<{ genre: string, count: number }>
  // Titles matching every other filter that are already in the library.
  owned: number
}

export interface CatalogSyncStatus {
  syncing: boolean
  // When the last sync finished; null before the first one.
  syncedAt: string | null
}

// GET /catalog: the cached catalog, searched, filtered, and sorted by the backend.
export interface CatalogResponse {
  // Configured peers with titles in the cache.
  peers: Array<{ id: string, name: string }>
  titles: CatalogTitle[]
  facets: CatalogFacets
  sync: CatalogSyncStatus
}

// GET/PATCH /config/catalog.
export interface CatalogConfig {
  // 5-field cron expression.
  refreshSchedule: string
}

export interface RequestServerOption {
  id: string
  name: string
  type: 'radarr' | 'sonarr'
  mediaType: 'movie' | 'tv'
  rootFolders: Array<{ path: string, freeSpace?: number }>
}

export interface CatalogRequestPayload {
  peerId: string
  serverId: string
  rootFolderPath: string
}

export interface Overview {
  peers: { total: number, initialized: number, items: PeerItem[] }
  servers: { total: number, initialized: number, sources: number, destinations: number, items: OverviewServerItem[] }
  downloads: {
    total: number
    byStatus: Record<string, number>
    bytesMoved: number
    mismatched: number
    active: DownloadItem[]
    importQueued: DownloadItem[]
    failed: DownloadItem[]
  }
  uploads: {
    total: number
    byStatus: Record<UploadItem['status'], number>
    bytesSent: number
    active: UploadItem[]
  }
}

// Secret refs mirror the backend's RawConfigSecret union.
export type SecretRef = string | { env: string } | { file: string }

export interface PeerInput {
  name: string
  url: string
  apiKey: SecretRef
  headers?: Record<string, SecretRef>
}

export interface ServerInput {
  name: string
  url: string
  apiKey: SecretRef
  type: 'radarr' | 'sonarr'
  source?: boolean
  destination?: boolean
  headers?: Record<string, SecretRef>
  autoregister?: { enable?: boolean, priority?: number }
}

// config.jack: internalUrl + optional secrets and the external access profile.
export interface ExternalJackConfig {
  instanceName?: string
  url: string
  headers?: Record<string, SecretRef>
}

export interface JackConfig {
  internalUrl: string
  apiKey?: SecretRef | null
  tmdbApiKey?: SecretRef | null
  external?: ExternalJackConfig
}

// config.downloads, exactly as persisted (null when the block is absent — downloads
// are not configured). Every field is optional: a PATCH is merged onto the stored
// block, so the UI only sends what it edits.
export interface DownloadsConfig {
  completedPath?: string
  maxConcurrentDownloads?: number
  maxDownloadAttempts?: number
  retryBaseDelayMs?: number
  retryMaxDelayMs?: number
  idleTimeoutMs?: number
  importPollIntervalMs?: number
  maxManualImportAttempts?: number
  manualImportBackoffBaseMs?: number
  manualImportBackoffMaxMs?: number
  unlinkImportedFiles?: boolean
  removeFailedDownloads?: boolean
  failedDownloadRetries?: number
  failedRetryBaseDelayMs?: number
}

// PATCH body for config.downloads. Absent leaves the stored value alone; `null` drops
// the key from the file so jack's default applies again (how the UI clears a field).
// `completedPath` has no default, so it can't be cleared.
export type DownloadsConfigPatch
  = & { completedPath?: string }
    & { [K in Exclude<keyof DownloadsConfig, 'completedPath'>]?: DownloadsConfig[K] | null }

export interface ApiKey {
  id: number
  name: string | null
  description: string | null
  expiresAt: string | null
  createdAt: string
  updatedAt: string
}

// POST /api-keys returns the raw key exactly once; every later read omits it.
export interface CreatedApiKey extends ApiKey {
  key: string
}

export interface ApiKeyInput {
  name?: string | null
  description?: string | null
  expiresAt?: string | null
}

export interface QuickLinkInput {
  peerName: string
  keyName: string
  keyDescription?: string | null
  expiresAt?: string | null
}

export interface CreatedQuickLink {
  link: string
  key: ApiKey
}

// One NDJSON log line as served by GET /logs and the /logs/stream SSE. `time` is
// epoch millis, `level` the pino numeric level, `severity` its label; anything
// else (trace_id, request fields, …) rides along as extra keys.
export interface LogRecord {
  time?: number
  level?: number
  severity?: string
  message?: string
  trace_id?: string
  [key: string]: unknown
}

// GET /stats: the dashboard charts. Daily series cover `days` (UTC, oldest first).
export interface DashboardStats {
  days: string[]
  transfers: {
    day: string
    downloadedBytes: number
    uploadedBytes: number
    downloadBps: number | null
    uploadBps: number | null
  }[]
  importLatency: { day: string, avgSeconds: number | null, count: number }[]
  peers: {
    // `id` is stable (peer id, API key id, or `master`); `name` is the latest label.
    gaveToMe: { id: string, name: string, bytes: number }[]
    tookFromMe: { id: string, name: string, bytes: number }[]
  }
  failures: { code: string, count: number }[]
  topTitles: { filename: string, bytes: number, requests: number, peers: number }[]
  catalog: {
    sources: { id: string, name: string }[]
    points: { day: string, sourceId: string, titles: number, bytes: number }[]
  }
}
