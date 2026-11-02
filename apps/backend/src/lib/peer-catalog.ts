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
 * `/peer/catalog?since=<revision>`: the titles that changed after `since`, or
 * the whole catalog (`full`) when `since` is absent or unknown to the peer.
 */
export const PeerCatalogResponse = z.object({
  // Pass this back as `since` on the next request.
  revision: z.number().int().nonnegative(),
  // True when `titles` is the whole catalog, so anything else the caller had
  // cached for this peer is gone.
  full: z.boolean(),
  // Added or changed titles.
  titles: z.array(PeerCatalogTitle),
  // Keys (see peerTitleKey) of titles removed since `since`. Empty when `full`.
  removed: z.array(z.string()),
})
export type PeerCatalogResponse = z.infer<typeof PeerCatalogResponse>
