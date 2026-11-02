import type { AppDatabase } from '../../database/connection'
import type { PeerCatalogResponse, PeerCatalogTitle } from '../../lib/peer-catalog'
import type { Release } from '../../lib/release'
import type { PeerCatalogDiff } from './catalog.lib'
import { and, eq, gt, inArray, max, notInArray } from 'drizzle-orm'
import { ownCatalogReleases, ownCatalogTitles } from '../../database/schema'
import { normalizeImdbId, ReleaseCategory } from '../../lib/release'
import { DELETE_CHUNK_SIZE, titleColumns, titleFromRow } from './catalog-cache.repository'
import { diffPeerCatalog } from './catalog.lib'

/** A title in the own catalog, with the releases behind it. */
export interface OwnCatalogEntry {
  title: PeerCatalogTitle
  releases: Release[]
}

/** What `/peer/search` filters by; ids arrive as strings from the query. */
export interface ReleaseSearch {
  imdbId?: string
  tmdbId?: string
  tvdbId?: string
  season?: number
  episode?: number
}

type Tx = Parameters<Parameters<AppDatabase['transaction']>[0]>[0]

function releaseColumns(titleKey: string, release: Release) {
  return {
    titleKey,
    mediaType: release.category === ReleaseCategory.Tv
      ? 'tv' as const
      : 'movie' as const,
    tmdbId: release.tmdbId ?? null,
    imdbId: release.imdbId
      ? normalizeImdbId(release.imdbId)
      : null,
    tvdbId: release.tvdbId ?? null,
    season: release.season ?? null,
    episode: release.episode ?? null,
    data: release,
  }
}

/**
 * This instance's own catalog: the titles served to peers on `/peer/catalog`,
 * and the releases behind them, which answer `/peer/search`. Each sync that
 * changes a title bumps the revision, so a peer can ask for just the changes
 * since the revision it last saw.
 */
export class OwnCatalogRepository {
  constructor(private readonly db: AppDatabase) {}

  /** The latest revision; 0 before the first sync. */
  currentRevision(): number {
    return this.db.select({
      revision: max(ownCatalogTitles.revision),
    }).from(ownCatalogTitles).get()?.revision ?? 0
  }

  /**
   * Bring the catalog in line with what the sources carry now. Changed, added,
   * and removed titles are stamped with one new revision; unchanged ones keep
   * theirs. Releases are diffed too, so only the ones that changed are written.
   * Returns the title diff.
   */
  applySnapshot(fresh: Map<string, OwnCatalogEntry>): PeerCatalogDiff {
    return this.db.transaction((tx) => {
      const rows = tx.select().from(ownCatalogTitles).where(eq(ownCatalogTitles.deleted, false)).all()
      const current = new Map(rows.map(row => [
        row.titleKey,
        titleFromRow(row),
      ]))
      const titles = new Map([...fresh].map(([key, entry]) => [key, entry.title]))
      const diff = diffPeerCatalog(current, titles)

      if (diff.added.size > 0 || diff.updated.size > 0 || diff.removed.length > 0) {
        const revision = this.nextRevision(tx)
        // A title removed earlier and back now still has its deleted row: upsert.
        for (const [titleKey, title] of [
          ...diff.added,
          ...diff.updated,
        ])
          this.upsertTitle(tx, titleKey, title, revision)
        for (const titleKey of diff.removed) {
          tx.update(ownCatalogTitles)
            .set({ revision, deleted: true })
            .where(eq(ownCatalogTitles.titleKey, titleKey))
            .run()
        }
      }

      this.syncReleases(tx, fresh)
      // Titles that are gone take their releases with them.
      const keep = [
        ...fresh.keys(),
      ]
      if (keep.length === 0)
        tx.delete(ownCatalogReleases).run()
      else
        tx.delete(ownCatalogReleases).where(notInArray(ownCatalogReleases.titleKey, keep)).run()
      return diff
    })
  }

  /**
   * Put one title in the catalog as the sources carry it now, under a new
   * revision when it differs from what's stored, and replace its releases.
   * Returns whether the title changed.
   */
  applyTitle(titleKey: string, entry: OwnCatalogEntry): boolean {
    return this.db.transaction((tx) => {
      const row = tx.select().from(ownCatalogTitles).where(eq(ownCatalogTitles.titleKey, titleKey)).get()
      const current = row && !row.deleted
        ? new Map([
            [
              titleKey,
              titleFromRow(row),
            ],
          ])
        : new Map<string, PeerCatalogTitle>()
      const diff = diffPeerCatalog(current, new Map([
        [titleKey, entry.title],
      ]))
      const changed = diff.added.size > 0 || diff.updated.size > 0
      if (changed)
        this.upsertTitle(tx, titleKey, entry.title, this.nextRevision(tx))
      this.syncReleases(tx, new Map([
        [titleKey, entry],
      ]))
      return changed
    })
  }

  /**
   * Releases matching a `/peer/search` query, mirroring what the sources answer
   * live: a tmdb or imdb id finds movies, a tvdb id (optionally narrowed to a
   * season and episode) finds episodes, and no id lists everything. Null before
   * the first sync, so the caller asks the sources instead.
   */
  searchReleases(params: ReleaseSearch): Release[] | null {
    if (!this.db.select({ titleKey: ownCatalogTitles.titleKey }).from(ownCatalogTitles).limit(1).get())
      return null

    let condition
    if (params.tmdbId) {
      const tmdbId = Number(params.tmdbId)
      if (!Number.isInteger(tmdbId))
        return []
      condition = and(eq(ownCatalogReleases.mediaType, 'movie'), eq(ownCatalogReleases.tmdbId, tmdbId))
    }
    else if (params.imdbId) {
      condition = and(eq(ownCatalogReleases.mediaType, 'movie'), eq(ownCatalogReleases.imdbId, normalizeImdbId(params.imdbId)))
    }
    else if (params.tvdbId) {
      const tvdbId = Number(params.tvdbId)
      if (!Number.isInteger(tvdbId))
        return []
      condition = and(
        eq(ownCatalogReleases.mediaType, 'tv'),
        eq(ownCatalogReleases.tvdbId, tvdbId),
        params.season == null
          ? undefined
          : eq(ownCatalogReleases.season, params.season),
        params.episode == null
          ? undefined
          : eq(ownCatalogReleases.episode, params.episode),
      )
    }

    return this.db.select({ data: ownCatalogReleases.data }).from(ownCatalogReleases).where(condition).all().map(row => row.data)
  }

  /**
   * What changed after `since`: the whole catalog when `since` is absent or newer
   * than anything here (this instance's database was reset), otherwise the titles
   * stamped after it plus the keys removed after it.
   */
  changesSince(since?: number): PeerCatalogResponse {
    const revision = this.currentRevision()
    if (since === undefined || since > revision) {
      const rows = this.db.select().from(ownCatalogTitles).where(eq(ownCatalogTitles.deleted, false)).all()
      return {
        revision,
        full: true,
        titles: rows.map(titleFromRow),
        removed: [],
      }
    }
    const rows = this.db.select().from(ownCatalogTitles).where(gt(ownCatalogTitles.revision, since)).all()
    return {
      revision,
      full: false,
      titles: rows.filter(row => !row.deleted).map(titleFromRow),
      removed: rows.filter(row => row.deleted).map(row => row.titleKey),
    }
  }

  private nextRevision(tx: Tx): number {
    return (tx.select({
      revision: max(ownCatalogTitles.revision),
    }).from(ownCatalogTitles).get()?.revision ?? 0) + 1
  }

  private upsertTitle(tx: Tx, titleKey: string, title: PeerCatalogTitle, revision: number): void {
    const columns = {
      ...titleColumns(title),
      revision,
      deleted: false,
    }
    tx.insert(ownCatalogTitles)
      .values({ titleKey, ...columns })
      .onConflictDoUpdate({ target: ownCatalogTitles.titleKey, set: columns })
      .run()
  }

  /** Make each given title's releases match `entries`, writing only what changed. */
  private syncReleases(tx: Tx, entries: Map<string, OwnCatalogEntry>): void {
    const keys = [
      ...entries.keys(),
    ]
    const stored = new Map<string, string>()
    for (let i = 0; i < keys.length; i += DELETE_CHUNK_SIZE) {
      const rows = tx.select({ id: ownCatalogReleases.id, data: ownCatalogReleases.data })
        .from(ownCatalogReleases)
        .where(inArray(ownCatalogReleases.titleKey, keys.slice(i, i + DELETE_CHUNK_SIZE)))
        .all()
      for (const row of rows)
        stored.set(row.id, JSON.stringify(row.data))
    }

    const seen = new Set<string>()
    for (const [titleKey, { releases }] of entries) {
      for (const release of releases) {
        seen.add(release.id)
        if (stored.get(release.id) === JSON.stringify(release))
          continue
        const columns = releaseColumns(titleKey, release)
        tx.insert(ownCatalogReleases)
          .values({ id: release.id, ...columns })
          .onConflictDoUpdate({ target: ownCatalogReleases.id, set: columns })
          .run()
      }
    }

    const gone = [
      ...stored.keys(),
    ].filter(id => !seen.has(id))
    for (let i = 0; i < gone.length; i += DELETE_CHUNK_SIZE)
      tx.delete(ownCatalogReleases).where(inArray(ownCatalogReleases.id, gone.slice(i, i + DELETE_CHUNK_SIZE))).run()
  }
}
