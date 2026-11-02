import type { AppDatabase } from '../../database/connection'
import type { TmdbMediaType, TmdbMetadata, TmdbMetadataStore } from '../../lib/tmdb/client'
import { and, eq } from 'drizzle-orm'
import { tmdbMetadata } from '../../database/schema'

/** Persisted TMDB lookups. A stored null means TMDB has no entry for the id. */
export class TmdbMetadataRepository implements TmdbMetadataStore {
  constructor(private readonly db: AppDatabase) {}

  /** The stored lookup, or undefined when the id was never looked up. */
  get(mediaType: TmdbMediaType, tmdbId: number): TmdbMetadata | null | undefined {
    const row = this.db.select().from(tmdbMetadata).where(and(eq(tmdbMetadata.mediaType, mediaType), eq(tmdbMetadata.tmdbId, tmdbId))).get()
    return row
      ? (row.data ?? null)
      : undefined
  }

  set(mediaType: TmdbMediaType, tmdbId: number, data: TmdbMetadata | null): void {
    const fetchedAt = new Date().toISOString()
    this.db.insert(tmdbMetadata)
      .values({ mediaType, tmdbId, data, fetchedAt })
      .onConflictDoUpdate({
        target: [tmdbMetadata.mediaType, tmdbMetadata.tmdbId],
        set: { data, fetchedAt },
      })
      .run()
  }

  /** Every stored lookup, keyed `${mediaType}:${tmdbId}`. */
  all(): Map<string, TmdbMetadata | null> {
    const rows = this.db.select().from(tmdbMetadata).all()
    return new Map(rows.map(row => [`${row.mediaType}:${row.tmdbId}`, row.data ?? null]))
  }
}
