// The shape of GET /stats. Built in SQL by StatsRepository.dashboard().

export interface BucketTransfer {
  /** Start of the bucket, ISO 8601. */
  at: string
  downloadedBytes: number
  uploadedBytes: number
  /** Average over the bucket's finished transfers: their bytes over their wall time. */
  downloadBps: number | null
  uploadBps: number | null
}

/**
 * A peer in a ranking. `id` is stable (the peer id for downloads, the API key id
 * for uploads, `master` for the master key); `name` is its latest display name.
 */
export interface RankedPeer {
  id: string
  name: string
  bytes: number
}

export interface DashboardStats {
  range: StatsRange
  /** Width of one bucket in milliseconds. */
  bucketMs: number
  /** Bucket starts (ISO 8601), oldest first; every series has one entry per bucket. */
  buckets: string[]
  transfers: BucketTransfer[]
  importLatency: { at: string, avgSeconds: number | null, count: number }[]
  /** Fastest, average and slowest single import in the window; null without imports. */
  importSummary: { minSeconds: number | null, avgSeconds: number | null, maxSeconds: number | null, count: number }
  /** Lifetime bytes per peer, largest first. */
  peers: {
    gaveToMe: RankedPeer[]
    tookFromMe: RankedPeer[]
  }
  /** Downloads that are failed right now, by error code, most common first. */
  failures: { code: string, count: number }[]
  /** Files peers pulled most from this instance, by confirmed bytes sent. */
  topTitles: { filename: string, bytes: number, requests: number, peers: number }[]
  /** Catalog size is recorded once per UTC day, so these points stay daily. */
  catalog: {
    sources: { id: string, name: string }[]
    points: { day: string, sourceId: string, titles: number, bytes: number }[]
  }
}

const SECOND_MS = 1000
const MINUTE_MS = 60 * SECOND_MS
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS

/** The history windows the dashboard offers, and the bucket width for each. */
export const STATS_RANGES = {
  '5m': { spanMs: 5 * MINUTE_MS, bucketMs: 10 * SECOND_MS },
  '30m': { spanMs: 30 * MINUTE_MS, bucketMs: MINUTE_MS },
  '1h': { spanMs: HOUR_MS, bucketMs: 2 * MINUTE_MS },
  '24h': { spanMs: DAY_MS, bucketMs: HOUR_MS },
  '7d': { spanMs: 7 * DAY_MS, bucketMs: 6 * HOUR_MS },
  '30d': { spanMs: 30 * DAY_MS, bucketMs: DAY_MS },
} as const

export type StatsRange = keyof typeof STATS_RANGES

export const DEFAULT_STATS_RANGE: StatsRange = '30d'

export function isStatsRange(value: unknown): value is StatsRange {
  return typeof value === 'string' && Object.hasOwn(STATS_RANGES, value)
}

/**
 * Bucket starts for `range`, oldest first, the last one holding `now`. Buckets
 * are aligned to multiples of their width since the epoch, so daily buckets
 * start at UTC midnight.
 */
export function rangeBuckets(range: StatsRange, now = Date.now()): string[] {
  const { spanMs, bucketMs } = STATS_RANGES[range]
  const count = spanMs / bucketMs
  const last = Math.floor(now / bucketMs) * bucketMs
  return Array.from({ length: count }, (_, i) => new Date(last - (count - 1 - i) * bucketMs).toISOString())
}
