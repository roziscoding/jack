export interface ConnectorBase {
  id: string
  name: string
  url: string
  type: string
  initialized: boolean
  initializationError: string | null
}

export interface PeerItem extends ConnectorBase {
  version: string | null
}

export interface ServerItem extends ConnectorBase {
  source: boolean
  destination: boolean
}

export interface DownloadItem {
  id: number
  filename: string
  peerName: string
  peerId: string
  status: 'downloading' | 'completed' | 'failed' | 'import_queued'
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

export interface Overview {
  peers: { total: number, initialized: number, items: PeerItem[] }
  servers: { total: number, initialized: number, sources: number, destinations: number, items: ServerItem[] }
  downloads: { total: number, byStatus: Record<string, number>, active: DownloadItem[] }
}

// Secret refs mirror the backend's RawConfigSecret union.
export type SecretRef = string | { env: string } | { file: string }

export interface PeerInput {
  name: string
  url: string
  apiKey: SecretRef
  headers?: Record<string, string>
}

export interface ServerInput {
  name: string
  url: string
  apiKey: SecretRef
  type: 'radarr' | 'sonarr'
  source?: boolean
  destination?: boolean
  headers?: Record<string, string>
  autoregister?: { enable?: boolean, priority?: number }
}
