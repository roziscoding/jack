import type { DownloadRecord } from '../downloads/downloads.repository'
import type { UploadRecord } from '../uploads/uploads.repository'
import type { CatalogSizePoint } from './stats.repository'

const DAY_MS = 86_400_000
const TOP_TITLES = 10

export interface DailyTransfer {
  day: string
  downloadedBytes: number
  uploadedBytes: number
  /** Average over that day's finished transfers: their bytes over their wall time. */
  downloadBps: number | null
  uploadBps: number | null
}

export interface DashboardStats {
  /** UTC days, oldest first; every series below has one entry per day. */
  days: string[]
  transfers: DailyTransfer[]
  importLatency: { day: string, avgSeconds: number | null, count: number }[]
  /** Lifetime bytes per peer, largest first. */
  peers: {
    gaveToMe: { name: string, bytes: number }[]
    tookFromMe: { name: string, bytes: number }[]
  }
  /** Downloads that are failed right now, by error code, most common first. */
  failures: { code: string, count: number }[]
  /** Files peers pulled most from this instance, by bytes sent. */
  topTitles: { filename: string, bytes: number, requests: number, peers: number }[]
  catalog: {
    sources: { id: string, name: string }[]
    points: { day: string, sourceId: string, titles: number, bytes: number }[]
  }
}

function dayOf(iso: string): string {
  return iso.slice(0, 10)
}

function durationMs(from: string, to: string): number {
  return Math.max(0, Date.parse(to) - Date.parse(from))
}

function ranked(totals: Map<string, number>): { name: string, bytes: number }[] {
  return [...totals].map(([name, bytes]) => ({ name, bytes })).filter(p => p.bytes > 0).sort((a, b) => b.bytes - a.bytes)
}

function add(map: Map<string, number>, key: string, value: number): void {
  map.set(key, (map.get(key) ?? 0) + value)
}

/** Everything the dashboard charts need, computed from the stored rows. */
export function buildStats(
  downloads: DownloadRecord[],
  uploads: UploadRecord[],
  catalogPoints: CatalogSizePoint[],
  dayCount: number,
  now = Date.now(),
): DashboardStats {
  const days = Array.from({ length: dayCount }, (_, i) => dayOf(new Date(now - (dayCount - 1 - i) * DAY_MS).toISOString()))
  const inRange = new Set(days)
  const buckets = new Map(days.map(day => [
    day,
    {
      down: 0,
      up: 0,
      downTimed: 0,
      downMs: 0,
      upTimed: 0,
      upMs: 0,
      latencyMs: 0,
      latencyCount: 0,
    },
  ]))

  const gaveToMe = new Map<string, number>()
  const failures = new Map<string, number>()
  for (const d of downloads) {
    add(gaveToMe, d.peerName, d.downloadedBytes)
    if (d.status === 'failed')
      add(failures, d.errorCode ?? 'UNKNOWN_ERROR', 1)
    if (!d.completedAt)
      continue
    const bucket = buckets.get(dayOf(d.completedAt))
    if (bucket) {
      bucket.down += d.downloadedBytes
      bucket.downTimed += d.downloadedBytes
      bucket.downMs += durationMs(d.startedAt, d.completedAt)
    }
    if (!d.importedAt)
      continue
    const imported = buckets.get(dayOf(d.importedAt))
    if (imported) {
      imported.latencyMs += durationMs(d.completedAt, d.importedAt)
      imported.latencyCount++
    }
  }

  const tookFromMe = new Map<string, number>()
  const titles = new Map<string, { bytes: number, requests: number, peers: Set<string> }>()
  for (const u of uploads) {
    add(tookFromMe, u.peerName, u.sentBytes)
    const title = titles.get(u.filename) ?? {
      bytes: 0,
      requests: 0,
      peers: new Set<string>(),
    }
    title.bytes += u.sentBytes
    title.requests++
    title.peers.add(u.peerName)
    titles.set(u.filename, title)
    if (!u.finishedAt)
      continue
    const bucket = buckets.get(dayOf(u.finishedAt))
    if (!bucket)
      continue
    // Bytes and time come from the downloading jack's receipt, so only confirmed
    // uploads count; files go out zero-copy and jack never measures them itself.
    bucket.up += u.sentBytes
    if (u.status === 'completed' && u.durationMs) {
      bucket.upTimed += u.sentBytes
      bucket.upMs += u.durationMs
    }
  }

  const sources = new Map<string, string>()
  const points = []
  for (const p of catalogPoints) {
    if (!inRange.has(p.day))
      continue
    // The newest name wins, so a renamed peer shows its current name.
    sources.set(p.sourceId, p.sourceName)
    points.push({
      day: p.day,
      sourceId: p.sourceId,
      titles: p.titles,
      bytes: p.bytes,
    })
  }

  return {
    days,
    transfers: days.map((day) => {
      const b = buckets.get(day)!
      return {
        day,
        downloadedBytes: b.down,
        uploadedBytes: b.up,
        downloadBps: b.downMs > 0
          ? (b.downTimed * 1000) / b.downMs
          : null,
        uploadBps: b.upMs > 0
          ? (b.upTimed * 1000) / b.upMs
          : null,
      }
    }),
    importLatency: days.map((day) => {
      const b = buckets.get(day)!
      return {
        day,
        avgSeconds: b.latencyCount > 0
          ? Math.round(b.latencyMs / b.latencyCount / 1000)
          : null,
        count: b.latencyCount,
      }
    }),
    peers: {
      gaveToMe: ranked(gaveToMe),
      tookFromMe: ranked(tookFromMe),
    },
    failures: [...failures].map(([code, count]) => ({ code, count })).sort((a, b) => b.count - a.count),
    topTitles: [...titles]
      .map(([filename, t]) => ({
        filename,
        bytes: t.bytes,
        requests: t.requests,
        peers: t.peers.size,
      }))
      .filter(t => t.bytes > 0)
      .sort((a, b) => b.bytes - a.bytes)
      .slice(0, TOP_TITLES),
    catalog: {
      sources: [...sources].map(([id, name]) => ({ id, name })),
      points,
    },
  }
}
