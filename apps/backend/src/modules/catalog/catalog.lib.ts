import type { PeerCatalogTitle } from '../../lib/peer-catalog'
import type { Release } from '../../lib/release'
import type { LibraryEntry } from '../../lib/servers/arr/base'
import type { TmdbMetadata } from '../../lib/tmdb/client'
import { normalizeImdbId, ReleaseCategory } from '../../lib/release'

export type { PeerCatalogTitle }

/** A peer's catalog, tagged with the peer it came from. */
export interface PeerCatalog {
  peer: { id: string, name: string }
  titles: PeerCatalogTitle[]
}

/** One peer's contribution to a unified title. */
export interface CatalogTitlePeer {
  id: string
  name: string
  releaseCount: number
  totalSize: number
  resolutions: number[]
}

/** A title unified across every peer that carries it. */
export interface UnifiedCatalogTitle {
  key: string
  mediaType: 'movie' | 'tv'
  tmdbId?: number
  imdbId?: string
  tvdbId?: number
  displayTitle: string
  // Artwork and genres from the peers' *arr metadata, when they send it.
  posterUrl?: string
  backdropUrl?: string
  genres: string[]
  // Totals across every peer that carries this title.
  releaseCount: number
  totalSize: number
  // Absent until looked up; null when TMDB has no entry for the id.
  metadata?: TmdbMetadata | null
  // True when a local Radarr/Sonarr already has at least one file for this title.
  inLibrary: boolean
  peers: CatalogTitlePeer[]
}

/** A peer's flat release list, tagged with the peer it came from. */
export interface PeerReleases {
  peer: { id: string, name: string }
  releases: Release[]
}

interface TitleIds {
  mediaType: 'movie' | 'tv'
  tmdbId?: number
  imdbId?: string
  tvdbId?: number
}

/** The strong (id-based) grouping key, or null when the item carries no usable id. */
function strongKey(item: TitleIds): string | null {
  const id = item.mediaType === 'tv'
    ? (item.tvdbId ?? item.tmdbId)
    : (item.tmdbId ?? item.imdbId)
  return id == null
    ? null
    : `${item.mediaType}:id:${id}`
}

/** The fallback (name-based) key for an item with no usable id. */
function nameKey(mediaType: 'movie' | 'tv', name: string): string {
  return `${mediaType}:name:${name.toLowerCase()}`
}

/** The key a single peer's title is stored under in the cache. */
export function peerTitleKey(title: PeerCatalogTitle): string {
  return strongKey(title) ?? nameKey(title.mediaType, title.title)
}

/**
 * Build a key function for a set of items: the strong id key, else the id key
 * that every id-bearing item with the same name agrees on, else the name key.
 * This folds an id-less item into the id-bearing title of the same name, unless
 * that name maps to more than one id.
 */
function keyResolver<T extends TitleIds>(items: T[], nameOf: (item: T) => string): (item: T) => string {
  const strongKeysByName = new Map<string, Set<string>>()
  for (const item of items) {
    const sk = strongKey(item)
    if (!sk)
      continue
    const nk = nameKey(item.mediaType, nameOf(item))
    const keys = strongKeysByName.get(nk) ?? new Set<string>()
    keys.add(sk)
    strongKeysByName.set(nk, keys)
  }

  const nameToStrongKey = new Map<string, string>()
  for (const [nk, keys] of strongKeysByName) {
    if (keys.size !== 1)
      continue
    const key = keys.values().next().value
    if (typeof key === 'string')
      nameToStrongKey.set(nk, key)
  }

  return (item) => {
    const nk = nameKey(item.mediaType, nameOf(item))
    return strongKey(item) ?? nameToStrongKey.get(nk) ?? nk
  }
}

function mediaTypeOf(release: Release): 'movie' | 'tv' {
  return release.category === ReleaseCategory.Tv
    ? 'tv'
    : 'movie'
}

function releaseName(release: Release): string {
  return mediaTypeOf(release) === 'tv'
    ? (release.seriesTitle ?? release.title)
    : (release.movieTitle ?? release.title)
}

function sortResolutions(resolutions: Iterable<number>): number[] {
  return [
    ...new Set(resolutions),
  ].sort((a, b) => b - a)
}

function unionGenres(a: string[] | undefined, b: string[] | undefined): string[] | undefined {
  if (!a?.length) {
    return b?.length
      ? [...b]
      : undefined
  }
  if (!b?.length)
    return a
  return [
    ...new Set([
      ...a,
      ...b,
    ]),
  ]
}

/**
 * Add `next` into `into`: sum the totals, union the resolutions and genres,
 * backfill ids and artwork.
 */
export function mergeTitle(into: PeerCatalogTitle, next: PeerCatalogTitle): void {
  into.tmdbId ??= next.tmdbId
  into.imdbId ??= next.imdbId
  into.tvdbId ??= next.tvdbId
  into.posterUrl ??= next.posterUrl
  into.backdropUrl ??= next.backdropUrl
  into.genres = unionGenres(into.genres, next.genres)
  if (!into.genres)
    delete into.genres
  into.releaseCount += next.releaseCount
  into.totalSize += next.totalSize
  into.resolutions = sortResolutions([
    ...into.resolutions,
    ...next.resolutions,
  ])
}

/** Fold one peer's releases into one summary per movie/series. */
export function summarizeReleases(releases: Release[]): PeerCatalogTitle[] {
  const items = releases.map(release => ({
    mediaType: mediaTypeOf(release),
    tmdbId: release.tmdbId,
    imdbId: release.imdbId,
    tvdbId: release.tvdbId,
    release,
  }))
  const keyOf = keyResolver(items, item => releaseName(item.release))

  const byKey = new Map<string, PeerCatalogTitle>()
  for (const item of items) {
    const resolution = item.release.quality?.resolution
    const summary: PeerCatalogTitle = {
      mediaType: item.mediaType,
      tmdbId: item.tmdbId,
      imdbId: item.imdbId,
      tvdbId: item.tvdbId,
      title: releaseName(item.release),
      releaseCount: 1,
      totalSize: item.release.size,
      resolutions: resolution
        ? [resolution]
        : [],
    }
    const key = keyOf(item)
    const existing = byKey.get(key)
    if (existing)
      mergeTitle(existing, summary)
    else
      byKey.set(key, summary)
  }
  return [
    ...byKey.values(),
  ]
}

/**
 * Index a peer's titles by their cache key, merging duplicates. A peer that serves
 * `/peer/catalog` already sends one entry per title, but nothing on the wire
 * guarantees it.
 */
export function indexPeerTitles(titles: PeerCatalogTitle[]): Map<string, PeerCatalogTitle> {
  const byKey = new Map<string, PeerCatalogTitle>()
  for (const title of titles) {
    const key = peerTitleKey(title)
    const existing = byKey.get(key)
    if (existing) {
      mergeTitle(existing, title)
    }
    else {
      byKey.set(key, {
        ...title,
        resolutions: sortResolutions(title.resolutions),
      })
    }
  }
  return byKey
}

/**
 * Fold every peer's titles into one title per movie/series. Keys are resolved
 * across all peers at once, so a title that is id-less on one peer and id-bearing
 * on another still collapses into one.
 */
export function groupPeerCatalogs(catalogs: PeerCatalog[]): UnifiedCatalogTitle[] {
  const entries = catalogs.flatMap(({ peer, titles }) => titles.map(title => ({ ...title, peer })))
  const keyOf = keyResolver(entries, entry => entry.title)

  const byKey = new Map<string, UnifiedCatalogTitle>()
  for (const entry of entries) {
    const key = keyOf(entry)
    let title = byKey.get(key)
    if (!title) {
      title = {
        key,
        mediaType: entry.mediaType,
        tmdbId: entry.tmdbId,
        imdbId: entry.imdbId,
        tvdbId: entry.tvdbId,
        displayTitle: entry.title,
        genres: [],
        releaseCount: 0,
        totalSize: 0,
        inLibrary: false,
        peers: [],
      }
      byKey.set(key, title)
    }

    // Backfill ids and artwork if a later entry carries what the first lacked.
    title.tmdbId ??= entry.tmdbId
    title.imdbId ??= entry.imdbId
    title.tvdbId ??= entry.tvdbId
    title.posterUrl ??= entry.posterUrl
    title.backdropUrl ??= entry.backdropUrl
    title.genres = unionGenres(title.genres, entry.genres) ?? []
    title.releaseCount += entry.releaseCount
    title.totalSize += entry.totalSize

    // The same peer can land twice on one title when its id-less and id-bearing
    // entries collapse together.
    const bucket = title.peers.find(p => p.id === entry.peer.id)
    if (bucket) {
      bucket.releaseCount += entry.releaseCount
      bucket.totalSize += entry.totalSize
      bucket.resolutions = sortResolutions([
        ...bucket.resolutions,
        ...entry.resolutions,
      ])
    }
    else {
      title.peers.push({
        id: entry.peer.id,
        name: entry.peer.name,
        releaseCount: entry.releaseCount,
        totalSize: entry.totalSize,
        resolutions: sortResolutions(entry.resolutions),
      })
    }
  }

  return [
    ...byKey.values(),
  ].sort((a, b) => a.displayTitle.localeCompare(b.displayTitle))
}

/** Summarize each peer's releases, then unify them across peers. */
export function groupReleasesIntoUnifiedTitles(peerReleases: PeerReleases[]): UnifiedCatalogTitle[] {
  return groupPeerCatalogs(peerReleases.map(({ peer, releases }) => ({
    peer,
    titles: summarizeReleases(releases),
  })))
}

export interface PeerCatalogDiff {
  added: Map<string, PeerCatalogTitle>
  updated: Map<string, PeerCatalogTitle>
  removed: string[]
}

function sameTitle(a: PeerCatalogTitle, b: PeerCatalogTitle): boolean {
  return a.mediaType === b.mediaType
    && a.tmdbId === b.tmdbId
    && a.imdbId === b.imdbId
    && a.tvdbId === b.tvdbId
    && a.title === b.title
    && a.releaseCount === b.releaseCount
    && a.totalSize === b.totalSize
    && a.posterUrl === b.posterUrl
    && a.backdropUrl === b.backdropUrl
    && sameList(a.resolutions, b.resolutions)
    && sameList(a.genres ?? [], b.genres ?? [])
}

function sameList<T>(a: T[], b: T[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i])
}

/** What changed between the cached titles of a peer and a fresh fetch of them. */
export function diffPeerCatalog(cached: Map<string, PeerCatalogTitle>, fresh: Map<string, PeerCatalogTitle>): PeerCatalogDiff {
  const diff: PeerCatalogDiff = {
    added: new Map(),
    updated: new Map(),
    removed: [],
  }
  for (const [key, title] of fresh) {
    const previous = cached.get(key)
    if (!previous)
      diff.added.set(key, title)
    else if (!sameTitle(previous, title))
      diff.updated.set(key, title)
  }
  for (const key of cached.keys()) {
    if (!fresh.has(key))
      diff.removed.push(key)
  }
  return diff
}

/**
 * Set `inLibrary` on every title the local library holds, matching on any shared
 * external id within the same media type. Ids are compared as strings with the
 * imdb `tt` prefix dropped, since peers and *arr don't agree on that form.
 */
export function markInLibrary(titles: UnifiedCatalogTitle[], library: LibraryEntry[]): void {
  const owned = new Set<string>()
  for (const entry of library) {
    for (const key of idKeys(entry))
      owned.add(key)
  }
  for (const title of titles)
    title.inLibrary = idKeys(title).some(key => owned.has(key))
}

function idKeys(item: TitleIds): string[] {
  const keys: string[] = []
  if (item.tmdbId != null)
    keys.push(`${item.mediaType}:tmdb:${item.tmdbId}`)
  if (item.imdbId)
    keys.push(`${item.mediaType}:imdb:${normalizeImdbId(item.imdbId)}`)
  if (item.tvdbId != null)
    keys.push(`${item.mediaType}:tvdb:${item.tvdbId}`)
  return keys
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
  return releases.reduce<Release | undefined>((best, r) => (!best || isBetterRelease(r, best))
    ? r
    : best, undefined)
}

export function pickBestPerEpisode(releases: Release[]): Release[] {
  const byEpisode = new Map<string, Release>()
  for (const r of releases) {
    const key = r.season != null && r.episode != null
      ? `${r.season}:${r.episode}`
      : `unparsed:${r.id}`
    const current = byEpisode.get(key)
    if (!current || isBetterRelease(r, current))
      byEpisode.set(key, r)
  }
  return [
    ...byEpisode.values(),
  ]
}
