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
 * Whether `text` contains every word of `query`, in any order, after both are
 * normalized. An empty query matches everything.
 */
export function matchesSearch(text: string, query: string): boolean {
  const words = normalizeForSearch(query).split(' ').filter(Boolean)
  if (words.length === 0)
    return true
  const haystack = normalizeForSearch(text)
  return words.every(word => haystack.includes(word))
}
