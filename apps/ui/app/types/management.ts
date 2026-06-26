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

export interface DownloadItem {
  id: number
  filename: string
  peerName: string
  peerId: string
  status: 'downloading' | 'import_queued' | 'imported' | 'failed'
  downloadedBytes: number
  totalBytes: number | null
  progress: number | null
  releaseSize: number
  attempts: number
  error: string | null
  startedAt: string
  updatedAt: string
  completedAt: string | null
  expectedBytesMismatch: boolean
}

export interface CatalogTitle {
  key: string
  mediaType: 'movie' | 'tv'
  tmdbId?: number
  imdbId?: string
  tvdbId?: number
  displayTitle: string
  releaseCount: number
  totalSize: number
}

export interface PeerCatalogResponse {
  peer: { id: string, name: string }
  titles: CatalogTitle[]
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

// config.jack: internalUrl + the optional, deprecated single "Main API key".
// apiKey mirrors the backend RawConfigSecret ref (or null/absent when unset).
export interface JackConfig {
  internalUrl: string
  apiKey?: SecretRef | null
}

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
