import type { CatalogTitle, TmdbMetadata } from '~/types/management'

export interface CatalogMetadataEntry {
  status: 'loading' | 'loaded' | 'error'
  data: TmdbMetadata | null
}

/**
 * Drives per-title TMDB enrichment from the client. The catalog endpoint returns
 * titles unenriched; each visible poster card calls `load` on mount and reads its
 * metadata back from a shared, page-scoped cache. The browser's own connection
 * pool handles concurrency, so titles fill in progressively instead of blocking
 * the whole catalog on one giant server-side fan-out.
 */
export function useCatalogMetadata() {
  const { request } = useManagement()
  // useState (not a module-level ref) so the cache survives card unmount/remount
  // across pagination and filter changes, and is shared by every card + the detail panel.
  const cache = useState<Record<string, CatalogMetadataEntry>>('catalog-tmdb', () => ({}))

  function keyFor(title: CatalogTitle): string | null {
    return title.tmdbId == null ? null : `${title.mediaType}:${title.tmdbId}`
  }

  function entryFor(title: CatalogTitle): CatalogMetadataEntry | null {
    const key = keyFor(title)
    return key ? (cache.value[key] ?? null) : null
  }

  async function load(title: CatalogTitle): Promise<void> {
    const key = keyFor(title)
    // No id to look up, or already loading/loaded — don't refetch.
    if (!key || cache.value[key])
      return
    cache.value[key] = { status: 'loading', data: null }
    try {
      const data = await request<TmdbMetadata | null>(`catalog/tmdb/${title.mediaType}/${title.tmdbId}`)
      cache.value[key] = { status: 'loaded', data }
    }
    catch {
      // A failed lookup must not blank the card — fall back to the placeholder.
      cache.value[key] = { status: 'error', data: null }
    }
  }

  return { load, entryFor }
}
