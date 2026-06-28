import type { Release } from '../../lib/release'
import type { TmdbMetadata } from '../../lib/tmdb/client'
import { ReleaseCategory } from '../../lib/release'

/** Per-release detail kept for a title within a single peer's bucket. */
export type CatalogRelease = Pick<Release, 'id' | 'title' | 'filename' | 'size' | 'quality' | 'season' | 'episode'>

/** One peer's contribution to a unified title. */
export interface CatalogTitlePeer {
  id: string
  name: string
  releaseCount: number
  totalSize: number
  releases: CatalogRelease[]
}

/** A title unified across every peer that carries it. */
export interface UnifiedCatalogTitle {
  key: string
  mediaType: 'movie' | 'tv'
  tmdbId?: number
  imdbId?: string
  tvdbId?: number
  displayTitle: string
  // Totals across every peer that carries this title.
  releaseCount: number
  totalSize: number
  metadata?: TmdbMetadata | null
  peers: CatalogTitlePeer[]
}

/** A peer's flat release list, tagged with the peer it came from. */
export interface PeerReleases {
  peer: { id: string, name: string }
  releases: Release[]
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
 * Fold every peer's releases into one title per movie/series.
 *
 * Reuses the single-peer grouping keys (strong id key, else the name->id alias from
 * pass 1, else the name key) but builds the alias map across ALL peers' releases so a
 * title that is id-less on one peer and id-bearing on another still collapses. Each
 * title tracks a per-peer bucket with that peer's release detail.
 */
export function groupReleasesIntoUnifiedTitles(peerReleases: PeerReleases[]): UnifiedCatalogTitle[] {
  const strongKeysByName = new Map<string, Set<string>>()
  for (const { releases } of peerReleases) {
    for (const release of releases) {
      const sk = strongKey(release)
      if (!sk)
        continue
      const nk = nameKey(release)
      const keys = strongKeysByName.get(nk) ?? new Set<string>()
      keys.add(sk)
      strongKeysByName.set(nk, keys)
    }
  }

  const nameToStrongKey = new Map<string, string>()
  for (const [nk, keys] of strongKeysByName) {
    if (keys.size !== 1)
      continue
    const key = keys.values().next().value
    if (typeof key === 'string')
      nameToStrongKey.set(nk, key)
  }

  const keyOf = (release: Release): string =>
    strongKey(release) ?? nameToStrongKey.get(nameKey(release)) ?? nameKey(release)

  const byKey = new Map<string, UnifiedCatalogTitle>()
  for (const { peer, releases } of peerReleases) {
    for (const release of releases) {
      const key = keyOf(release)

      let title = byKey.get(key)
      if (!title) {
        title = {
          key,
          mediaType: mediaTypeOf(release),
          tmdbId: release.tmdbId,
          imdbId: release.imdbId,
          tvdbId: release.tvdbId,
          displayTitle: mediaTypeOf(release) === 'tv' ? (release.seriesTitle ?? release.title) : release.title,
          releaseCount: 0,
          totalSize: 0,
          peers: [],
        }
        byKey.set(key, title)
      }

      // Backfill ids if a later release carries one the first lacked.
      title.tmdbId ??= release.tmdbId
      title.imdbId ??= release.imdbId
      title.tvdbId ??= release.tvdbId
      title.releaseCount += 1
      title.totalSize += release.size

      let bucket = title.peers.find(p => p.id === peer.id)
      if (!bucket) {
        bucket = { id: peer.id, name: peer.name, releaseCount: 0, totalSize: 0, releases: [] }
        title.peers.push(bucket)
      }
      bucket.releaseCount += 1
      bucket.totalSize += release.size
      bucket.releases.push({
        id: release.id,
        title: release.title,
        filename: release.filename,
        size: release.size,
        quality: release.quality,
        season: release.season,
        episode: release.episode,
      })
    }
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
    const key = r.season != null && r.episode != null ? `${r.season}:${r.episode}` : `unparsed:${r.id}`
    const current = byEpisode.get(key)
    if (!current || isBetterRelease(r, current))
      byEpisode.set(key, r)
  }
  return [...byEpisode.values()]
}
