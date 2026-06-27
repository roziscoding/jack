import type { Release } from '../../lib/release'
import type { TmdbMetadata } from '../../lib/tmdb/client'
import { ReleaseCategory } from '../../lib/release'

export interface CatalogTitle {
  // Stable grouping key, also used as the client-side list key.
  key: string
  mediaType: 'movie' | 'tv'
  tmdbId?: number
  imdbId?: string
  tvdbId?: number
  // Best display name available pre-TMDB: series title for tv, else the release/scene title.
  displayTitle: string
  releaseCount: number
  totalSize: number
  metadata?: TmdbMetadata | null
}

function mediaTypeOf(release: Release): 'movie' | 'tv' {
  return release.category === ReleaseCategory.Tv ? 'tv' : 'movie'
}

/** The strong (id-based) grouping key for a release, or null when it carries no id. */
function strongKey(release: Release): string | null {
  const mediaType = mediaTypeOf(release)
  const id = mediaType === 'tv'
    ? (release.tvdbId ?? release.tmdbId)
    : (release.tmdbId ?? release.imdbId)
  return id == null ? null : `${mediaType}:id:${id}`
}

/** The fallback (name-based) key for a release with no usable id. */
function nameKey(release: Release): string {
  const mediaType = mediaTypeOf(release)
  const name = (mediaType === 'tv' ? (release.seriesTitle ?? release.title) : release.title).toLowerCase()
  return `${mediaType}:name:${name}`
}

/**
 * Group a peer's flat release list into one entry per movie/series.
 *
 * Two passes so a title that appears both WITH and WITHOUT an id still collapses:
 * pass 1 records, per fallback name, the strong id key seen for it; pass 2 routes
 * each release to its strong key, else the alias discovered in pass 1, else its name.
 */
export function groupReleasesIntoTitles(releases: Release[]): CatalogTitle[] {
  const nameToStrongKey = new Map<string, string>()
  for (const release of releases) {
    const sk = strongKey(release)
    if (sk && !nameToStrongKey.has(nameKey(release)))
      nameToStrongKey.set(nameKey(release), sk)
  }

  const byKey = new Map<string, CatalogTitle>()
  for (const release of releases) {
    const key = strongKey(release) ?? nameToStrongKey.get(nameKey(release)) ?? nameKey(release)

    const existing = byKey.get(key)
    if (existing) {
      existing.releaseCount += 1
      existing.totalSize += release.size
      // Backfill ids if a later release carries one the first lacked.
      existing.tmdbId ??= release.tmdbId
      existing.imdbId ??= release.imdbId
      existing.tvdbId ??= release.tvdbId
      continue
    }

    byKey.set(key, {
      key,
      mediaType: mediaTypeOf(release),
      tmdbId: release.tmdbId,
      imdbId: release.imdbId,
      tvdbId: release.tvdbId,
      displayTitle: mediaTypeOf(release) === 'tv' ? (release.seriesTitle ?? release.title) : release.title,
      releaseCount: 1,
      totalSize: release.size,
    })
  }

  return [...byKey.values()].sort((a, b) => a.displayTitle.localeCompare(b.displayTitle))
}

/**
 * Higher resolution wins; ties break to the larger file; full ties break to the
 * lexicographically lowest release id so the pick is deterministic regardless of
 * the order the peer returns its catalog in.
 */
function isBetterRelease(candidate: Release, current: Release): boolean {
  const c = candidate.quality?.resolution ?? 0
  const r = current.quality?.resolution ?? 0
  if (c !== r)
    return c > r
  if (candidate.size !== current.size)
    return candidate.size > current.size
  return candidate.id.localeCompare(current.id) < 0
}

export function pickBestRelease(releases: Release[]): Release | undefined {
  return releases.reduce<Release | undefined>((best, r) => (!best || isBetterRelease(r, best)) ? r : best, undefined)
}

export function pickBestPerEpisode(releases: Release[]): Release[] {
  const byEpisode = new Map<string, Release>()
  for (const r of releases) {
    const key = `${r.season ?? 0}:${r.episode ?? 0}`
    const current = byEpisode.get(key)
    if (!current || isBetterRelease(r, current))
      byEpisode.set(key, r)
  }
  return [...byEpisode.values()]
}
