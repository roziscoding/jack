import type { AppDatabase } from '../../database/connection'
import type { PeerCatalogResponse, PeerCatalogTitle } from '../../lib/peer-catalog'
import type { Release } from '../../lib/release'
import type { PeerCatalogDiff } from './catalog.lib'
import { and, eq, gt, inArray, max, notInArray } from 'drizzle-orm'
import { ownCatalogMeta, ownCatalogReleases, ownCatalogSourceTitles, ownCatalogTitles } from '../../database/schema'
import { normalizeImdbId, ReleaseCategory } from '../../lib/release'
import { DELETE_CHUNK_SIZE, titleColumns, titleFromRow } from './catalog-cache.repository'
import { diffPeerCatalog, mergeTitle } from './catalog.lib'

/** A title as one source carries it, with the releases behind it. */
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

function releaseColumns(sourceId: string, titleKey: string, release: Release) {
  return {
    sourceId,
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

function chunks<T>(items: T[]): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += DELETE_CHUNK_SIZE)
    out.push(items.slice(i, i + DELETE_CHUNK_SIZE))
  return out
}

/**
 * This instance's own catalog. Each source's titles and releases are stored as
 * of its last successful read; the catalog served on `/peer/catalog` is merged
 * from the sources enabled now, and `/peer/search` reads only their releases.
 * Each merge that changes a title bumps the revision, so a peer can ask for
 * just the changes since the revision it last saw.
 */
export class OwnCatalogRepository {
  // The source set the served catalog was last merged from; null until merged.
  private mergedFrom: string | null = null

  constructor(private readonly db: AppDatabase) {}

  /** This catalog's generation, created on first use and kept for the database's life. */
  generation(): string {
    const row = this.db.select().from(ownCatalogMeta).where(eq(ownCatalogMeta.id, 1)).get()
    if (row)
      return row.generation
    const generation = crypto.randomUUID()
    this.db.insert(ownCatalogMeta).values({ id: 1, generation }).onConflictDoNothing().run()
    return this.db.select().from(ownCatalogMeta).where(eq(ownCatalogMeta.id, 1)).get()!.generation
  }

  /** The latest revision; 0 before the first merge. */
  currentRevision(): number {
    return this.db.select({
      revision: max(ownCatalogTitles.revision),
    }).from(ownCatalogTitles).get()?.revision ?? 0
  }

  /**
   * Store what a source carries now. With `onlyKeys`, just those titles are
   * replaced (a title missing from `entries` is dropped for this source);
   * otherwise the whole source is. Only rows that changed are written.
   */
  replaceSource(sourceId: string, entries: Map<string, OwnCatalogEntry>, onlyKeys?: string[]): void {
    // Make sure the meta row exists before recording the read in it.
    this.generation()
    this.db.transaction((tx) => {
      tx.update(ownCatalogMeta).set({
        sourcesReadAt: new Date().toISOString(),
      }).where(eq(ownCatalogMeta.id, 1)).run()
      const scope = onlyKeys
        ? and(eq(ownCatalogSourceTitles.sourceId, sourceId), inArray(ownCatalogSourceTitles.titleKey, onlyKeys))
        : eq(ownCatalogSourceTitles.sourceId, sourceId)
      const stored = new Map(tx.select().from(ownCatalogSourceTitles).where(scope).all().map(row => [
        row.titleKey,
        JSON.stringify(row.data),
      ]))
      for (const [titleKey, { title }] of entries) {
        if (stored.get(titleKey) === JSON.stringify(title))
          continue
        tx.insert(ownCatalogSourceTitles)
          .values({ sourceId, titleKey, data: title })
          .onConflictDoUpdate({
            target: [ownCatalogSourceTitles.sourceId, ownCatalogSourceTitles.titleKey],
            set: { data: title },
          })
          .run()
      }
      const goneKeys = [
        ...stored.keys(),
      ].filter(key => !entries.has(key))
      for (const chunk of chunks(goneKeys)) {
        tx.delete(ownCatalogSourceTitles)
          .where(and(eq(ownCatalogSourceTitles.sourceId, sourceId), inArray(ownCatalogSourceTitles.titleKey, chunk)))
          .run()
      }

      this.replaceReleases(tx, sourceId, entries, onlyKeys)
    })
  }

  /** Forget every source not in `sourceIds` (removed from the config, or no longer a source). */
  dropSourcesExcept(sourceIds: string[]): void {
    this.db.transaction((tx) => {
      if (sourceIds.length === 0) {
        tx.delete(ownCatalogSourceTitles).run()
        tx.delete(ownCatalogReleases).run()
        return
      }
      tx.delete(ownCatalogSourceTitles).where(notInArray(ownCatalogSourceTitles.sourceId, sourceIds)).run()
      tx.delete(ownCatalogReleases).where(notInArray(ownCatalogReleases.sourceId, sourceIds)).run()
    })
  }

  /**
   * Merge the served catalog from the titles of `sourceIds`. Changed, added, and
   * removed titles are stamped with one new revision; unchanged ones keep theirs.
   * Returns the diff.
   */
  merge(sourceIds: string[]): PeerCatalogDiff {
    const diff = this.db.transaction((tx) => {
      const rows = sourceIds.length === 0
        ? []
        : tx.select().from(ownCatalogSourceTitles).where(inArray(ownCatalogSourceTitles.sourceId, sourceIds)).all()
      // Two sources can carry the same title (e.g. a 4K and a 1080p Radarr).
      const fresh = new Map<string, PeerCatalogTitle>()
      for (const row of rows) {
        const existing = fresh.get(row.titleKey)
        if (existing) {
          mergeTitle(existing, row.data)
        }
        else {
          fresh.set(row.titleKey, {
            ...row.data,
            resolutions: [...row.data.resolutions],
          })
        }
      }

      const served = tx.select().from(ownCatalogTitles).where(eq(ownCatalogTitles.deleted, false)).all()
      const current = new Map(served.map(row => [
        row.titleKey,
        titleFromRow(row),
      ]))
      const diff = diffPeerCatalog(current, fresh)
      if (diff.added.size === 0 && diff.updated.size === 0 && diff.removed.length === 0)
        return diff

      const revision = (tx.select({
        revision: max(ownCatalogTitles.revision),
      }).from(ownCatalogTitles).get()?.revision ?? 0) + 1
      // A title removed earlier and back now still has its deleted row: upsert.
      for (const [titleKey, title] of [
        ...diff.added,
        ...diff.updated,
      ]) {
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
      for (const titleKey of diff.removed) {
        tx.update(ownCatalogTitles)
          .set({ revision, deleted: true })
          .where(eq(ownCatalogTitles.titleKey, titleKey))
          .run()
      }
      return diff
    })
    this.mergedFrom = sourceKey(sourceIds)
    return diff
  }

  /**
   * What changed after `since`: the whole catalog when `since` is absent, comes
   * from another generation, or is newer than anything here; otherwise the titles
   * stamped after it plus the keys removed after it. Re-merges first when the
   * enabled sources changed since the last merge.
   */
  changesSince(sourceIds: string[], since?: number, generation?: string): PeerCatalogResponse {
    this.ensureMerged(sourceIds)
    const current = this.generation()
    const revision = this.currentRevision()
    if (since === undefined || generation !== current || since > revision) {
      const rows = this.db.select().from(ownCatalogTitles).where(eq(ownCatalogTitles.deleted, false)).all()
      return {
        revision,
        generation: current,
        full: true,
        titles: rows.map(titleFromRow),
        removed: [],
      }
    }
    const rows = this.db.select().from(ownCatalogTitles).where(gt(ownCatalogTitles.revision, since)).all()
    return {
      revision,
      generation: current,
      full: false,
      titles: rows.filter(row => !row.deleted).map(titleFromRow),
      removed: rows.filter(row => row.deleted).map(row => row.titleKey),
    }
  }

  /**
   * Releases from `sourceIds` matching a `/peer/search` query, mirroring what the
   * sources answer live: a tmdb or imdb id finds movies, a tvdb id (optionally
   * narrowed to a season and episode) finds episodes, and no id lists everything.
   * Null until a source has been read, so the caller asks the sources instead.
   */
  searchReleases(sourceIds: string[], params: ReleaseSearch): Release[] | null {
    if (!this.db.select().from(ownCatalogMeta).where(eq(ownCatalogMeta.id, 1)).get()?.sourcesReadAt)
      return null
    if (sourceIds.length === 0)
      return []

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

    return this.db.select({ data: ownCatalogReleases.data })
      .from(ownCatalogReleases)
      .where(and(inArray(ownCatalogReleases.sourceId, sourceIds), condition))
      .all()
      .map(row => row.data)
  }

  private ensureMerged(sourceIds: string[]): void {
    if (this.mergedFrom !== sourceKey(sourceIds)) {
      this.dropSourcesExcept(sourceIds)
      this.merge(sourceIds)
    }
  }

  /** Make a source's releases (for `onlyKeys`, or all of them) match `entries`. */
  private replaceReleases(tx: Tx, sourceId: string, entries: Map<string, OwnCatalogEntry>, onlyKeys?: string[]): void {
    const scope = onlyKeys
      ? and(eq(ownCatalogReleases.sourceId, sourceId), inArray(ownCatalogReleases.titleKey, onlyKeys))
      : eq(ownCatalogReleases.sourceId, sourceId)
    const stored = new Map(tx.select({ id: ownCatalogReleases.id, titleKey: ownCatalogReleases.titleKey, data: ownCatalogReleases.data })
      .from(ownCatalogReleases)
      .where(scope)
      .all()
      .map(row => [row.id, `${row.titleKey}\n${JSON.stringify(row.data)}`]))

    const seen = new Set<string>()
    for (const [titleKey, { releases }] of entries) {
      for (const release of releases) {
        seen.add(release.id)
        if (stored.get(release.id) === `${titleKey}\n${JSON.stringify(release)}`)
          continue
        const columns = releaseColumns(sourceId, titleKey, release)
        tx.insert(ownCatalogReleases)
          .values({ id: release.id, ...columns })
          .onConflictDoUpdate({ target: ownCatalogReleases.id, set: columns })
          .run()
      }
    }
    for (const chunk of chunks([
      ...stored.keys(),
    ].filter(id => !seen.has(id))))
      tx.delete(ownCatalogReleases).where(inArray(ownCatalogReleases.id, chunk)).run()
  }
}

function sourceKey(sourceIds: string[]): string {
  return [...sourceIds].sort().join('\n')
}
