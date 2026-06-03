import z from 'zod'

/**
 * A `Release` is jack's normalized view of a downloadable item that a source
 * (a local Radarr/Sonarr library, or a peer jack) can serve. It mirrors the
 * file metadata Radarr/Sonarr track so a requesting *arr can parse quality and
 * match it, and it carries everything the blackhole/streaming path needs.
 *
 * It deliberately does NOT carry the absolute file path: the path never leaves
 * the source jack, which re-resolves it on demand when streaming the file. That
 * keeps a Release safe to serialize anywhere (peer JSON, torznab output).
 */

export const ReleaseQuality = z.object({
  name: z.string().optional(),
  source: z.string().optional(),
  resolution: z.number().optional(),
})

export type ReleaseQuality = z.infer<typeof ReleaseQuality>

export const ReleaseCategory = {
  Movie: 2000,
  Tv: 5000,
} as const

export const Release = z.object({
  // `${sourceConnectorId}:${kind}:${fileId}` — opaque to consumers, resolved by
  // the source jack to fetch metadata / stream the file. kind is 'movie' | 'episode'.
  id: z.string(),
  // The release/scene name (basename without extension) — what *arr parses for quality.
  title: z.string(),
  // The real file basename, with extension — used to name the completed download.
  filename: z.string(),
  category: z.union([z.literal(2000), z.literal(5000)]),
  size: z.number(),
  imdbId: z.string().optional(),
  tmdbId: z.number().optional(),
  tvdbId: z.number().optional(),
  quality: ReleaseQuality.optional(),
  languages: z.array(z.string()).optional(),
  releaseGroup: z.string().optional(),
  edition: z.string().optional(),
  // The *arr MediaInfoResource as-is (codecs, runtime, resolution, ...).
  mediaInfo: z.record(z.string(), z.unknown()).optional(),
  seriesTitle: z.string().optional(),
  season: z.number().optional(),
  episode: z.number().optional(),
  publishDate: z.string().optional(),
})

export type Release = z.infer<typeof Release>

const IMDB_TT_PREFIX = /^tt/i

/**
 * Normalize an IMDb id for comparison. Radarr/Sonarr store ids with the `tt`
 * prefix (`tt0133093`), but torznab/newznab clients query without it
 * (`imdbid=0133093`). Strip the prefix so both forms compare equal.
 */
export function normalizeImdbId(id: string): string {
  return id.replace(IMDB_TT_PREFIX, '')
}
