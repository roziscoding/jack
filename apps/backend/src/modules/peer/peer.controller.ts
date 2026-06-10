import type { Release } from '../../lib/release'
import type { ArrServerConnector } from '../../lib/servers/arr/base'
import { setSpanAttribute, setSpanAttributes } from '../../lib/span-attributes'
import { withSpan } from '../../lib/tracing'
import { logger } from '../../logger'

const RANGE_HEADER_PATTERN = /^bytes=(\d*)-(\d*)$/

/**
 * Parse a single-range HTTP `Range` header. Returns `null` (→ serve full 200)
 * for an absent, malformed, or multi-range header; a `{ start?, end? }` for a
 * well-formed single range. `start === undefined` means a suffix range
 * (`bytes=-N` → last N bytes); `end === undefined` means open-ended
 * (`bytes=N-` → to end of file).
 */
export function parseRangeHeader(value: string | undefined | null): { start?: number, end?: number } | null {
  if (!value)
    return null
  const match = RANGE_HEADER_PATTERN.exec(value.trim())
  if (!match)
    return null
  const [, rawStart, rawEnd] = match
  if (rawStart === '' && rawEnd === '')
    return null
  const start = rawStart === '' ? undefined : Number(rawStart)
  const end = rawEnd === '' ? undefined : Number(rawEnd)
  if ((start != null && !Number.isSafeInteger(start)) || (end != null && !Number.isSafeInteger(end)))
    return null
  return { start, end }
}

// `body` is the raw BunFile (or a sliced view of it), NOT a manual ReadableStream.
// Handing the BunFile straight to `new Response` lets Bun.serve stream it with native
// backpressure (sendfile): if the consumer stalls or aborts mid-download, we stop
// reading from disk instead of buffering the whole file into RAM. Pumping `.stream()`
// ourselves does NOT backpressure and lets one stalled peer OOM the process.
export type StreamFileResult
  = | { type: 'full', body: Blob, size: number, filename: string }
    | { type: 'partial', body: Blob, size: number, totalSize: number, start: number, end: number, filename: string }
    | { type: 'unsatisfiable', totalSize: number }

/**
 * Serves the /peer API that other jacks talk to. Reads availability from the
 * local arr sources (the `source: true` Radarr/Sonarr servers) and streams the
 * underlying files from disk.
 */
export class PeerController {
  constructor(
    private readonly sources: ArrServerConnector[],
  ) {}

  // Sources gated by config only (`source: true`). We deliberately do NOT filter
  // by `isInitialized` here: a source that failed to connect at boot is still
  // attempted and re-initialized lazily by @requireInitialization, so one that
  // came back online rejoins searches without a restart.
  private get sourceServers() {
    return this.sources.filter(s => s.canSource)
  }

  async search(params: { imdbId?: string, tmdbId?: string, tvdbId?: string, season?: number, episode?: number }): Promise<Release[]> {
    return withSpan('peer.search', {
      'search.imdb_id': params.imdbId,
      'search.tmdb_id': params.tmdbId,
      'search.tvdb_id': params.tvdbId,
      'search.season': params.season,
      'search.episode': params.episode,
      'source.total_count': this.sources.length,
      'source.enabled_count': this.sourceServers.length,
    }, async (span) => {
      const sources = this.sourceServers

      if (sources.length === 0) {
        setSpanAttribute(span, 'release.count', 0)
        return []
      }

      // Id-based lookup (precise, often server-side); with no id we return the
      // full catalog (used by the torznab RSS feed). No free-text matching — *arr
      // always searches by id, so the catalog + id lookups cover every case.
      // Each source is isolated: a failure is logged and treated as zero results.
      const results = await Promise.all(sources.map(async (source) => {
        try {
          return await withSpan('peer.source_search', {
            'source.name': source.name,
            'source.type': source.type,
          }, async (sourceSpan) => {
            const items = params.tmdbId
              ? await source.searchByTmdbId(params.tmdbId)
              : params.imdbId
                ? await source.searchByImdbId(params.imdbId)
                : params.tvdbId
                  ? await source.searchByTvdbId(params.tvdbId, params.season, params.episode)
                  : await source.listReleases()
            setSpanAttribute(sourceSpan, 'release.count', items.length)
            return items
          })
        }
        catch (err) {
          logger.error({ source: source.name, type: source.type, params, err }, 'Source search failed — skipping this source')
          return []
        }
      }))

      const flat = results.flat()
      setSpanAttribute(span, 'release.count', flat.length)
      return flat
    })
  }

  async getItem(id: string): Promise<Release | null> {
    const source = this.findSource(id)
    if (!source)
      return null
    return source.getRelease(id)
  }

  // A release id is `${connectorId}:${kind}:${entityId}`; route it to the arr
  // source that produced it.
  private findSource(id: string): ArrServerConnector | undefined {
    const connectorId = id.split(':')[0]
    return this.sourceServers.find(s => s.id === connectorId)
  }

  async streamFile(id: string, rangeHeader?: string | null): Promise<StreamFileResult | null> {
    return withSpan('peer.stream_file', {
      'item.id': id,
    }, async (span) => {
      const source = this.findSource(id)
      if (!source) {
        setSpanAttribute(span, 'source.found', false)
        return null
      }

      setSpanAttributes(span, {
        'source.found': true,
        'source.name': source.name,
        'source.type': source.type,
      })

      const filePath = await source.getFilePath(id)
      if (!filePath) {
        setSpanAttribute(span, 'file.path_found', false)
        return null
      }

      setSpanAttribute(span, 'file.path_found', true)
      const file = Bun.file(filePath)
      if (!await file.exists()) {
        setSpanAttribute(span, 'file.exists', false)
        logger.warn({ filePath, id }, 'File not found on disk')
        return null
      }

      const totalSize = file.size
      const filename = filePath.split('/').pop() ?? 'unknown'
      setSpanAttributes(span, { 'file.exists': true, 'file.size': totalSize })

      const range = parseRangeHeader(rangeHeader)
      if (!range) {
        return { type: 'full', body: file, size: totalSize, filename }
      }

      let start: number
      let end: number
      if (range.start == null) {
        // Suffix range: `bytes=-N` → last N bytes.
        const suffix = range.end ?? 0
        if (suffix <= 0) {
          setSpanAttribute(span, 'range.satisfiable', false)
          return { type: 'unsatisfiable', totalSize }
        }
        start = Math.max(totalSize - suffix, 0)
        end = totalSize - 1
      }
      else {
        start = range.start
        end = Math.min(range.end ?? totalSize - 1, totalSize - 1)
      }

      if (start > end || start >= totalSize) {
        setSpanAttribute(span, 'range.satisfiable', false)
        return { type: 'unsatisfiable', totalSize }
      }

      setSpanAttributes(span, { 'range.satisfiable': true, 'range.start': start, 'range.end': end })
      // Bun.file().slice is half-open [start, end), so +1 to include `end`.
      return { type: 'partial', body: file.slice(start, end + 1), size: end - start + 1, totalSize, start, end, filename }
    })
  }
}
