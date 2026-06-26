const TMDB_API_BASE = 'https://api.themoviedb.org/3'
const TMDB_IMAGE_BASE = 'https://image.tmdb.org/t/p/'

export type TmdbMediaType = 'movie' | 'tv'

export interface TmdbMetadata {
  tmdbId: number
  title: string
  overview: string | null
  year: number | null
  rating: number | null
  posterUrl: string | null
  backdropUrl: string | null
  genres: string[]
}

interface TmdbRawDetail {
  id: number
  title?: string
  name?: string
  overview?: string | null
  release_date?: string | null
  first_air_date?: string | null
  vote_average?: number | null
  poster_path?: string | null
  backdrop_path?: string | null
  genres?: Array<{ id: number, name: string }>
}

/** Assemble a TMDB image URL, or null when the path is absent. */
export function buildImageUrl(path: string | null | undefined, size = 'w500', base = TMDB_IMAGE_BASE): string | null {
  if (!path)
    return null
  return `${base}${size}${path}`
}

/** Normalize a TMDB movie/tv detail payload into our flat metadata shape. */
export function mapTmdbDetail(raw: TmdbRawDetail): TmdbMetadata {
  const date = raw.release_date ?? raw.first_air_date ?? null
  const yearNum = date && date.length >= 4 ? Number(date.slice(0, 4)) : Number.NaN
  return {
    tmdbId: raw.id,
    title: raw.title ?? raw.name ?? 'Untitled',
    overview: raw.overview || null,
    year: Number.isFinite(yearNum) ? yearNum : null,
    rating: typeof raw.vote_average === 'number' ? raw.vote_average : null,
    posterUrl: buildImageUrl(raw.poster_path),
    backdropUrl: buildImageUrl(raw.backdrop_path, 'w780'),
    genres: (raw.genres ?? []).map(g => g.name).filter((n): n is string => Boolean(n)),
  }
}

/**
 * Thin TMDB v3 read client. Holds a per-process cache keyed by media/id so a
 * catalog full of repeated titles enriches each unique id once.
 */
export class TmdbClient {
  private readonly cache = new Map<string, TmdbMetadata | null>()
  constructor(private readonly apiKey: string) {}

  /** True when the key authenticates against TMDB (`/configuration` returns 200). */
  async ping(): Promise<boolean> {
    const res = await fetch(`${TMDB_API_BASE}/configuration?api_key=${this.apiKey}`)
    return res.ok
  }

  /** Normalized metadata for a tmdb id, cached per process; null on 404. */
  async getMetadata(mediaType: TmdbMediaType, tmdbId: number): Promise<TmdbMetadata | null> {
    const key = `${mediaType}:${tmdbId}`
    const cached = this.cache.get(key)
    if (cached !== undefined)
      return cached

    const res = await fetch(`${TMDB_API_BASE}/${mediaType}/${tmdbId}?api_key=${this.apiKey}`)
    if (res.status === 404) {
      this.cache.set(key, null)
      return null
    }
    if (!res.ok)
      throw new Error(`TMDB ${mediaType}/${tmdbId} failed: ${res.status}`)
    const raw = await res.json() as TmdbRawDetail
    const meta = mapTmdbDetail(raw)
    this.cache.set(key, meta)
    return meta
  }
}
