// Radarr's and Sonarr's Parser.NormalizeTitle, which both use for `sortTitle`.
const PUNCTUATION = /[^\p{L}\p{N}_\s]/gu
const LEADING_ARTICLE = /^(?:a|an|the)\s/i
const DUPLICATE_SPACES = /\s{2,}/g

// Titles the *arrs pin by id so the leading "A" isn't read as an article
// (MovieTitleNormalizer and SeriesTitleNormalizer). Keyed `${mediaType}:${id}`:
// tmdb ids for movies, tvdb ids for series.
const OVERRIDES: Record<string, string> = {
  'movie:387354': 'a to z',
  'movie:1212922': 'a to z',
  'movie:888700': 'a to z the first alphabet',
  'movie:101273': 'a to zeppelin the story of led zeppelin',
  'tv:281588': 'a to z',
}

/**
 * The key Radarr and Sonarr sort titles by: punctuation removed, a leading
 * "a", "an", or "the" dropped, lowercased. "The Matrix" sorts as "matrix".
 */
export function sortTitle(title: string, pin?: { mediaType: 'movie' | 'tv', id?: number }): string {
  const pinned = pin?.id != null
    ? OVERRIDES[`${pin.mediaType}:${pin.id}`]
    : undefined
  if (pinned)
    return pinned
  return title
    .replace(PUNCTUATION, '')
    .replace(LEADING_ARTICLE, '')
    .replace(DUPLICATE_SPACES, ' ')
    .trim()
    .toLowerCase()
}
