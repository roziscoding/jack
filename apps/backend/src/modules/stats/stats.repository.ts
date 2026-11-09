import type { AppDatabase } from '../../database/connection'
import type { DashboardStats, RankedPeer } from './stats'
import { count, eq, gte, sql, sum } from 'drizzle-orm'
import { catalogSizeHistory, ownCatalogTitles, peerCatalogTitles } from '../../database/schema'
import { lastDays } from './stats'

export const OWN_CATALOG_SOURCE_ID = 'self'

const TOP_TITLES = 10
// SQLite's julianday() counts days; this turns a difference into milliseconds.
const MS_PER_DAY = 86_400_000

export type CatalogSizePoint = typeof catalogSizeHistory.$inferSelect

/**
 * The dashboard's numbers. Everything is aggregated in SQLite: the download and
 * upload history is kept forever and never loaded into memory for a chart.
 */
export class StatsRepository {
  constructor(private readonly db: AppDatabase) {}

  /**
   * Write today's catalog size for this instance and every configured peer
   * (`peerNames` maps peer id to display name). A peer with no cached titles gets
   * zero, so an emptied catalog reads as zero rather than a gap. Re-running the
   * same day overwrites that day's row.
   */
  recordCatalogSizes(peerNames: Map<string, string>, day = new Date().toISOString().slice(0, 10)): void {
    const own = this.db.select({
      titles: count(),
      bytes: sum(ownCatalogTitles.totalSize),
    })
      .from(ownCatalogTitles)
      .where(eq(ownCatalogTitles.deleted, false))
      .get()
    const peers = this.db.select({
      peerId: peerCatalogTitles.peerId,
      titles: count(),
      bytes: sum(peerCatalogTitles.totalSize),
    })
      .from(peerCatalogTitles)
      .groupBy(peerCatalogTitles.peerId)
      .all()
    const byPeer = new Map(peers.map(p => [p.peerId, p]))

    const rows = [
      {
        day,
        sourceId: OWN_CATALOG_SOURCE_ID,
        sourceName: 'This instance',
        titles: own?.titles ?? 0,
        bytes: Number(own?.bytes ?? 0),
      },
    ]
    for (const [peerId, name] of peerNames) {
      const peer = byPeer.get(peerId)
      rows.push({
        day,
        sourceId: peerId,
        sourceName: name,
        titles: peer?.titles ?? 0,
        bytes: Number(peer?.bytes ?? 0),
      })
    }

    this.db.insert(catalogSizeHistory)
      .values(rows)
      .onConflictDoUpdate({
        target: [catalogSizeHistory.day, catalogSizeHistory.sourceId],
        set: {
          sourceName: sql`excluded.source_name`,
          titles: sql`excluded.titles`,
          bytes: sql`excluded.bytes`,
        },
      })
      .run()
  }

  catalogSizesSince(day: string): CatalogSizePoint[] {
    return this.db.select().from(catalogSizeHistory).where(gte(catalogSizeHistory.day, day)).orderBy(catalogSizeHistory.day).all()
  }

  /** Everything GET /stats returns, for the last `dayCount` UTC days. */
  dashboard(dayCount: number, now = Date.now()): DashboardStats {
    const days = lastDays(dayCount, now)
    const since = days[0]!

    // Daily download volume and speed, bucketed by when the transfer finished.
    const downloadDays = this.db.all<{ day: string, bytes: number, ms: number }>(sql`
      select substr(completed_at, 1, 10) as day,
             sum(downloaded_bytes) as bytes,
             sum(round((julianday(completed_at) - julianday(started_at)) * ${MS_PER_DAY})) as ms
      from downloads
      where completed_at >= ${since}
      group by day`)
    // Upload volume and speed come from receipts; only confirmed uploads have bytes.
    const uploadDays = this.db.all<{ day: string, bytes: number, timed: number, ms: number }>(sql`
      select substr(finished_at, 1, 10) as day,
             sum(sent_bytes) as bytes,
             sum(case when status = 'completed' and duration_ms > 0 then sent_bytes else 0 end) as timed,
             sum(case when status = 'completed' and duration_ms > 0 then duration_ms else 0 end) as ms
      from uploads
      where finished_at >= ${since}
      group by day`)
    const latencyDays = this.db.all<{ day: string, seconds: number, n: number }>(sql`
      select substr(imported_at, 1, 10) as day,
             avg((julianday(imported_at) - julianday(completed_at)) * 86400) as seconds,
             count(*) as n
      from downloads
      where imported_at >= ${since} and completed_at is not null
      group by day`)

    // Rankings group by stable ids; SQLite takes the bare `name` column from the
    // row holding max(...), so each peer shows its latest name.
    const gaveToMe = this.db.all<{ id: string, name: string, bytes: number, at: string }>(sql`
      select peer_id as id, peer_name as name, sum(downloaded_bytes) as bytes, max(updated_at) as at
      from downloads
      group by peer_id
      having bytes > 0
      order by bytes desc`)
    const tookFromMe = this.db.all<{ id: number | null, name: string, bytes: number, at: string }>(sql`
      select peer_key_id as id, peer_name as name, sum(sent_bytes) as bytes, max(started_at) as at
      from uploads
      group by peer_key_id
      having bytes > 0
      order by bytes desc`)
    const failures = this.db.all<{ code: string | null, n: number }>(sql`
      select error_code as code, count(*) as n
      from downloads
      where status = 'failed'
      group by error_code
      order by n desc`)
    const topTitles = this.db.all<{ filename: string, bytes: number, requests: number, peers: number }>(sql`
      select filename,
             sum(sent_bytes) as bytes,
             count(*) as requests,
             count(distinct coalesce(peer_key_id, -1)) as peers
      from uploads
      group by filename
      having bytes > 0
      order by bytes desc
      limit ${TOP_TITLES}`)

    const down = new Map(downloadDays.map(d => [d.day, d]))
    const up = new Map(uploadDays.map(d => [d.day, d]))
    const latency = new Map(latencyDays.map(d => [d.day, d]))

    const sources = new Map<string, string>()
    const points = []
    for (const p of this.catalogSizesSince(since)) {
      // Rows come oldest first, so the newest name wins.
      sources.set(p.sourceId, p.sourceName)
      points.push({
        day: p.day,
        sourceId: p.sourceId,
        titles: p.titles,
        bytes: p.bytes,
      })
    }

    const rate = (bytes: number, ms: number) => ms > 0
      ? (bytes * 1000) / ms
      : null
    const ranked = (rows: { id: string | number | null, name: string, bytes: number }[]): RankedPeer[] =>
      rows.map(r => ({
        id: r.id == null
          ? 'master'
          : String(r.id),
        name: r.name,
        bytes: Number(r.bytes),
      }))

    return {
      days,
      transfers: days.map((day) => {
        const d = down.get(day)
        const u = up.get(day)
        return {
          day,
          downloadedBytes: Number(d?.bytes ?? 0),
          uploadedBytes: Number(u?.bytes ?? 0),
          downloadBps: d
            ? rate(Number(d.bytes), Number(d.ms))
            : null,
          uploadBps: u
            ? rate(Number(u.timed), Number(u.ms))
            : null,
        }
      }),
      importLatency: days.map((day) => {
        const l = latency.get(day)
        return {
          day,
          avgSeconds: l
            ? Math.round(Number(l.seconds))
            : null,
          count: Number(l?.n ?? 0),
        }
      }),
      peers: {
        gaveToMe: ranked(gaveToMe),
        tookFromMe: ranked(tookFromMe),
      },
      failures: failures.map(f => ({
        code: f.code ?? 'UNKNOWN_ERROR',
        count: Number(f.n),
      })),
      topTitles: topTitles.map(t => ({
        filename: t.filename,
        bytes: Number(t.bytes),
        requests: Number(t.requests),
        peers: Number(t.peers),
      })),
      catalog: {
        sources: [...sources].map(([id, name]) => ({ id, name })),
        points,
      },
    }
  }
}
