import type { DownloadStatus } from '../../database/schema'
import type { DownloadRecord } from '../downloads/downloads.repository'
import { getStubInfoHash } from '../torznab/torrent'

/**
 * The torrent's real BitTorrent infohash. jack has no peer wire, but *arr
 * computes this hash from the stub it grabbed and matches torrents/info by it,
 * so it MUST equal the served stub's infohash -- derive it from the same
 * (release title, size) the stub was built from, NOT from peerId:itemId.
 */
export function deriveHash(name: string, size: number): string {
  return getStubInfoHash(name, size)
}

/**
 * The qB category string jack assigns to a destination server. Unique per
 * server so two same-type *arr instances never see each other's torrents.
 */
export function qbCategoryForServer(serverId: string): string {
  return `jack-${serverId}`
}

export type QbState = 'downloading' | 'pausedUP' | 'error'

const ETA_UNKNOWN = 8_640_000 // qB's "unknown ETA" sentinel (= 100 days); *arr recognises this specific value as "no ETA"

function mapState(status: DownloadStatus): QbState {
  switch (status) {
    case 'completed':
    case 'import_queued':
      return 'pausedUP' // finished → *arr marks Completed and imports from content_path
    case 'failed':
      return 'error'
    case 'downloading':
    default:
      return 'downloading'
  }
}

function toEpoch(iso: string | null): number {
  if (!iso)
    return 0
  const ms = Date.parse(iso)
  return Number.isNaN(ms) ? 0 : Math.floor(ms / 1000)
}

export interface QbTorrent {
  hash: string
  name: string
  size: number
  total_size: number
  progress: number
  eta: number
  state: QbState
  category: string
  tags: string
  save_path: string
  content_path: string
  ratio: number
  ratio_limit: number
  seeding_time_limit: number
  amount_left: number
  completed: number
  completion_on: number
  added_on: number
  dlspeed: number
  upspeed: number
  num_seeds: number
  num_complete: number
  num_leechs: number
  num_incomplete: number
}

export function toQbTorrent(record: DownloadRecord, opts: { completedPath: string, category: string }): QbTorrent {
  const size = record.expectedBytes ?? record.releaseSize
  const isDone = record.status === 'completed' || record.status === 'import_queued'
  const progress = isDone ? 1 : (size > 0 ? Math.min(record.downloadedBytes / size, 1) : 0)
  const amountLeft = isDone ? 0 : Math.max(size - record.downloadedBytes, 0)
  return {
    // Real stub infohash (from release title + size), NOT peerId:itemId — *arr
    // matches torrents/info to the hash it computed from the grabbed .torrent.
    hash: deriveHash(record.release.title, record.releaseSize),
    name: record.filename,
    size,
    total_size: size,
    progress,
    eta: isDone ? 0 : ETA_UNKNOWN,
    state: mapState(record.status),
    category: opts.category,
    tags: '',
    save_path: opts.completedPath,
    content_path: record.destPath, // must differ from save_path or *arr warns "path error"
    ratio: 0,
    ratio_limit: -2,
    seeding_time_limit: -2,
    amount_left: amountLeft,
    completed: isDone ? size : record.downloadedBytes,
    completion_on: toEpoch(record.completedAt),
    added_on: toEpoch(record.startedAt),
    dlspeed: 0,
    upspeed: 0,
    num_seeds: 1,
    num_complete: 1,
    num_leechs: 0,
    num_incomplete: 0,
  }
}
