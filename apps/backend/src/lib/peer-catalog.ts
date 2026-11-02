import z from 'zod'

/**
 * One title as a peer carries it: totals and the distinct resolutions across its
 * releases, without the releases themselves. Served by `/peer/catalog` and stored
 * in the local catalog cache.
 */
export const PeerCatalogTitle = z.object({
  mediaType: z.enum(['movie', 'tv']),
  tmdbId: z.number().optional(),
  imdbId: z.string().optional(),
  tvdbId: z.number().optional(),
  title: z.string(),
  releaseCount: z.number().int().nonnegative(),
  totalSize: z.number().nonnegative(),
  // Distinct resolutions, best first (e.g. [2160, 1080]).
  resolutions: z.array(z.number()),
  // From the *arr's own metadata. Absent from peers older than 0.2.0, and from
  // titles summarized from releases.
  posterUrl: z.string().optional(),
  backdropUrl: z.string().optional(),
  genres: z.array(z.string()).optional(),
})
export type PeerCatalogTitle = z.infer<typeof PeerCatalogTitle>

/**
 * `/peer/catalog?since=<revision>&generation=<generation>`: the titles that
 * changed after `since`, or the whole catalog (`full`) when `since` is absent
 * or doesn't belong to the peer's current generation.
 */
export const PeerCatalogResponse = z.object({
  // Pass these back as `since` and `generation` on the next request.
  revision: z.number().int().nonnegative(),
  // Changes when the peer's catalog history starts over (its database was
  // reset), which makes earlier revisions meaningless.
  generation: z.string(),
  // True when `titles` is the whole catalog, so anything else the caller had
  // cached for this peer is gone.
  full: z.boolean(),
  // Added or changed titles.
  titles: z.array(PeerCatalogTitle),
  // Keys (see peerTitleKey) of titles removed since `since`. Empty when `full`.
  removed: z.array(z.string()),
})
export type PeerCatalogResponse = z.infer<typeof PeerCatalogResponse>
