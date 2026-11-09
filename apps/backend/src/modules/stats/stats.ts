// The shape of GET /stats. Built in SQL by StatsRepository.dashboard().

export interface DailyTransfer {
  day: string
  downloadedBytes: number
  uploadedBytes: number
  /** Average over that day's finished transfers: their bytes over their wall time. */
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
  /** UTC days, oldest first; every daily series has one entry per day. */
  days: string[]
  transfers: DailyTransfer[]
  importLatency: { day: string, avgSeconds: number | null, count: number }[]
  /** Lifetime bytes per peer, largest first. */
  peers: {
    gaveToMe: RankedPeer[]
    tookFromMe: RankedPeer[]
  }
  /** Downloads that are failed right now, by error code, most common first. */
  failures: { code: string, count: number }[]
  /** Files peers pulled most from this instance, by confirmed bytes sent. */
  topTitles: { filename: string, bytes: number, requests: number, peers: number }[]
  catalog: {
    sources: { id: string, name: string }[]
    points: { day: string, sourceId: string, titles: number, bytes: number }[]
  }
}

const DAY_MS = 86_400_000

/** The last `dayCount` UTC days ending today, oldest first. */
export function lastDays(dayCount: number, now = Date.now()): string[] {
  return Array.from({ length: dayCount }, (_, i) => new Date(now - (dayCount - 1 - i) * DAY_MS).toISOString().slice(0, 10))
}
