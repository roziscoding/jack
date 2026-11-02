const DIACRITICS = /\p{Diacritic}/gu
const NON_WORD_RUNS = /[^\p{L}\p{N}]+/gu

/**
 * Lowercase, strip accents, and turn every run of punctuation into a space, so
 * release names like "Big.Buck.Bunny.2024.2160p.WEB-DL" read as plain words.
 */
export function normalizeForSearch(text: string): string {
  return text
    .normalize('NFD')
    .replace(DIACRITICS, '')
    .toLowerCase()
    .replace(NON_WORD_RUNS, ' ')
    .trim()
}

/**
 * How well `text` matches `query` as a title: every query word must start a word
 * of `text` (so "silo" finds "Silo" but not "EPSiLON"), in any order. Lower is
 * better:
 *
 * - 0: the whole text is the query
 * - 1: the text starts with the query
 * - 2: every word matches somewhere else
 *
 * Returns null when some word doesn't match, and 2 for an empty query.
 */
export function titleSearchScore(text: string, query: string): number | null {
  const needle = normalizeForSearch(query)
  if (!needle)
    return 2
  const haystack = normalizeForSearch(text)
  const textWords = haystack.split(' ')
  const matches = needle.split(' ').every(word => textWords.some(t => t.startsWith(word)))
  if (!matches)
    return null
  if (haystack === needle)
    return 0
  return haystack.startsWith(needle)
    ? 1
    : 2
}
