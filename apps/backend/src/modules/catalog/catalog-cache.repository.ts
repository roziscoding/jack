import type { AppDatabase } from '../../database/connection'
import type { PeerCatalogTitleRow } from '../../database/schema'
import type { PeerCatalogDiff, PeerCatalogTitle } from './catalog.lib'
import { and, eq, inArray, notInArray } from 'drizzle-orm'
import { peerCatalogSync, peerCatalogTitles } from '../../database/schema'
import { diffPeerCatalog } from './catalog.lib'

// Keeps each `IN (...)` well under SQLite's bound-parameter limit.
export const DELETE_CHUNK_SIZE = 500

type TitleColumns = Pick<PeerCatalogTitleRow, 'mediaType' | 'tmdbId' | 'imdbId' | 'tvdbId' | 'title' | 'releaseCount' | 'totalSize' | 'resolutions' | 'posterUrl' | 'backdropUrl' | 'genres'>

export function titleFromRow(row: TitleColumns): PeerCatalogTitle {
  return {
    mediaType: row.mediaType,
    tmdbId: row.tmdbId ?? undefined,
    imdbId: row.imdbId ?? undefined,
    tvdbId: row.tvdbId ?? undefined,
    title: row.title,
    releaseCount: row.releaseCount,
    totalSize: row.totalSize,
    resolutions: row.resolutions,
    posterUrl: row.posterUrl ?? undefined,
    backdropUrl: row.backdropUrl ?? undefined,
    genres: row.genres ?? undefined,
  }
}

export function titleColumns(title: PeerCatalogTitle): TitleColumns {
  return {
    mediaType: title.mediaType,
    tmdbId: title.tmdbId ?? null,
    imdbId: title.imdbId ?? null,
    tvdbId: title.tvdbId ?? null,
    title: title.title,
    releaseCount: title.releaseCount,
    totalSize: title.totalSize,
    resolutions: title.resolutions,
    posterUrl: title.posterUrl ?? null,
    backdropUrl: title.backdropUrl ?? null,
    genres: title.genres ?? null,
  }
}

function toColumns(title: PeerCatalogTitle, updatedAt: string) {
  return {
    ...titleColumns(title),
    updatedAt,
  }
}

/** The last known catalog of every peer, one row per title per peer. */
export class CatalogCacheRepository {
  constructor(private readonly db: AppDatabase) {}

  /** Cached titles grouped by peer, limited to `peerIds`. */
  listByPeer(peerIds: string[]): Map<string, PeerCatalogTitle[]> {
    const byPeer = new Map<string, PeerCatalogTitle[]>()
    if (peerIds.length === 0)
      return byPeer
    const rows = this.db.select().from(peerCatalogTitles).where(inArray(peerCatalogTitles.peerId, peerIds)).all()
    for (const row of rows) {
      const titles = byPeer.get(row.peerId) ?? []
      titles.push(titleFromRow(row))
      byPeer.set(row.peerId, titles)
    }
    return byPeer
  }

  /**
   * Bring a peer's cached titles in line with a fresh fetch, writing only the rows
   * that changed. Returns the diff that was applied.
   */
  applyPeerCatalog(peerId: string, fresh: Map<string, PeerCatalogTitle>): PeerCatalogDiff {
    return this.db.transaction((tx) => {
      const rows = tx.select().from(peerCatalogTitles).where(eq(peerCatalogTitles.peerId, peerId)).all()
      const cached = new Map(rows.map(row => [
        row.titleKey,
        titleFromRow(row),
      ]))
      const diff = diffPeerCatalog(cached, fresh)
      const now = new Date().toISOString()

      for (const [titleKey, title] of diff.added) {
        tx.insert(peerCatalogTitles).values({
          peerId,
          titleKey,
          ...toColumns(title, now),
        }).run()
      }

      for (const [titleKey, title] of diff.updated) {
        tx.update(peerCatalogTitles)
          .set(toColumns(title, now))
          .where(and(eq(peerCatalogTitles.peerId, peerId), eq(peerCatalogTitles.titleKey, titleKey)))
          .run()
      }

      for (let i = 0; i < diff.removed.length; i += DELETE_CHUNK_SIZE) {
        const chunk = diff.removed.slice(i, i + DELETE_CHUNK_SIZE)
        tx.delete(peerCatalogTitles)
          .where(and(eq(peerCatalogTitles.peerId, peerId), inArray(peerCatalogTitles.titleKey, chunk)))
          .run()
      }

      return diff
    })
  }

  /**
   * Apply a peer's changes since the last sync: upsert `changed`, drop `removed`.
   * Unlike applyPeerCatalog, titles not mentioned are left alone.
   */
  applyPeerChanges(peerId: string, changed: Map<string, PeerCatalogTitle>, removed: string[]): void {
    const now = new Date().toISOString()
    this.db.transaction((tx) => {
      for (const [titleKey, title] of changed) {
        const columns = toColumns(title, now)
        tx.insert(peerCatalogTitles)
          .values({ peerId, titleKey, ...columns })
          .onConflictDoUpdate({
            target: [peerCatalogTitles.peerId, peerCatalogTitles.titleKey],
            set: columns,
          })
          .run()
      }
      for (let i = 0; i < removed.length; i += DELETE_CHUNK_SIZE) {
        tx.delete(peerCatalogTitles)
          .where(and(eq(peerCatalogTitles.peerId, peerId), inArray(peerCatalogTitles.titleKey, removed.slice(i, i + DELETE_CHUNK_SIZE))))
          .run()
      }
    })
  }

  /** The last revision applied for a peer; undefined when never synced or the peer serves no revisions. */
  getRevision(peerId: string): number | undefined {
    return this.db.select().from(peerCatalogSync).where(eq(peerCatalogSync.peerId, peerId)).get()?.revision ?? undefined
  }

  setRevision(peerId: string, revision: number | null): void {
    const syncedAt = new Date().toISOString()
    this.db.insert(peerCatalogSync)
      .values({ peerId, revision, syncedAt })
      .onConflictDoUpdate({
        target: peerCatalogSync.peerId,
        set: { revision, syncedAt },
      })
      .run()
  }

  /**
   * Drop the cache of every peer that is no longer configured. An empty set drops
   * everything (drizzle's notInArray(col, []) matches nothing, so handle it here).
   */
  deleteOrphans(activePeerIds: string[]): void {
    if (activePeerIds.length === 0) {
      this.db.delete(peerCatalogTitles).run()
      this.db.delete(peerCatalogSync).run()
      return
    }
    this.db.delete(peerCatalogTitles).where(notInArray(peerCatalogTitles.peerId, activePeerIds)).run()
    this.db.delete(peerCatalogSync).where(notInArray(peerCatalogSync.peerId, activePeerIds)).run()
  }
}
