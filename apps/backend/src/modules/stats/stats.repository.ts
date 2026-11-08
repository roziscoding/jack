import type { AppDatabase } from '../../database/connection'
import { count, eq, gte, sql, sum } from 'drizzle-orm'
import { catalogSizeHistory, ownCatalogTitles, peerCatalogTitles } from '../../database/schema'

export const OWN_CATALOG_SOURCE_ID = 'self'

export type CatalogSizePoint = typeof catalogSizeHistory.$inferSelect

/** History the dashboard can't rebuild from the download and upload rows. */
export class StatsRepository {
  constructor(private readonly db: AppDatabase) {}

  /**
   * Write today's catalog size for this instance and every peer. Re-running the
   * same day overwrites that day's row. `peerNames` maps peer ids to the name to
   * show; peers missing from it (no longer configured) are skipped.
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

    const rows = [
      {
        day,
        sourceId: OWN_CATALOG_SOURCE_ID,
        sourceName: 'This instance',
        titles: own?.titles ?? 0,
        bytes: Number(own?.bytes ?? 0),
      },
    ]
    for (const peer of peers) {
      const name = peerNames.get(peer.peerId)
      if (name) {
        rows.push({
          day,
          sourceId: peer.peerId,
          sourceName: name,
          titles: peer.titles,
          bytes: Number(peer.bytes ?? 0),
        })
      }
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
}
