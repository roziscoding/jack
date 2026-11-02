import type { UnifiedCatalogTitle } from './catalog.lib'
import { sortTitle } from '../../lib/sort-title'
import { titleSearchScore } from '../../lib/title-search'

export interface CatalogQuery {
  // Free text matched against the title (see titleSearchScore).
  q?: string
  type: 'all' | 'movie' | 'tv'
  // Titles any of these peers carry; empty means every peer.
  peers: string[]
  // Titles with any of these genres; empty means every genre.
  genres: string[]
  // Leave out titles the local library already has.
  hideOwned: boolean
}

export interface CatalogFacets {
  // Counts across the whole catalog, so each filter shows what it can reach.
  types: { all: number, movie: number, tv: number }
  peers: Record<string, number>
  genres: Array<{ genre: string, count: number }>
  // Titles matching every other filter that are already in the library: what
  // `hideOwned` removes.
  owned: number
}

/** The name a title is shown, searched, and sorted by. */
function titleName(title: UnifiedCatalogTitle): string {
  return title.metadata?.title ?? title.displayTitle
}

// Scored separately so an exact TMDB title still ranks first when the peer
// reported a release name.
function searchScore(title: UnifiedCatalogTitle, q: string): number | null {
  const scores = [
    titleName(title),
    title.displayTitle,
  ]
    .map(name => titleSearchScore(name, q))
    .filter((score): score is number => score !== null)
  return scores.length
    ? Math.min(...scores)
    : null
}

function sortKey(title: UnifiedCatalogTitle): string {
  return sortTitle(titleName(title), {
    mediaType: title.mediaType,
    id: title.mediaType === 'tv'
      ? title.tvdbId
      : title.tmdbId,
  })
}

function count(counts: Map<string, number>, key: string): void {
  counts.set(key, (counts.get(key) ?? 0) + 1)
}

/**
 * Filter, rank, and sort the catalog. While searching, the best matches come
 * first; otherwise, and among equal matches, titles sort the way Radarr and
 * Sonarr sort their libraries ("The Matrix" under M).
 */
export function queryCatalog(all: UnifiedCatalogTitle[], query: CatalogQuery): { titles: UnifiedCatalogTitle[], facets: CatalogFacets } {
  const peers = new Set(query.peers)
  const genres = new Set(query.genres)

  const matching = all
    .filter(t =>
      (query.type === 'all' || t.mediaType === query.type)
      && (peers.size === 0 || t.peers.some(p => peers.has(p.id)))
      && (genres.size === 0 || t.genres.some(g => genres.has(g))))
    .map(title => ({
      title,
      score: searchScore(title, query.q ?? ''),
      key: sortKey(title),
    }))
    .filter((entry): entry is { title: UnifiedCatalogTitle, score: number, key: string } => entry.score !== null)

  const owned = matching.filter(entry => entry.title.inLibrary).length
  const titles = matching
    .filter(entry => !query.hideOwned || !entry.title.inLibrary)
    .sort((a, b) => a.score - b.score || a.key.localeCompare(b.key))
    .map(entry => entry.title)

  const peerCounts = new Map<string, number>()
  const genreCounts = new Map<string, number>()
  for (const title of all) {
    for (const peer of title.peers)
      count(peerCounts, peer.id)
    for (const genre of title.genres)
      count(genreCounts, genre)
  }

  return {
    titles,
    facets: {
      types: {
        all: all.length,
        movie: all.filter(t => t.mediaType === 'movie').length,
        tv: all.filter(t => t.mediaType === 'tv').length,
      },
      peers: Object.fromEntries(peerCounts),
      genres: [
        ...genreCounts,
      ]
        .map(([genre, n]) => ({ genre, count: n }))
        .sort((a, b) => a.genre.localeCompare(b.genre)),
      owned,
    },
  }
}
