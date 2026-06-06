import type { ConnectorHeadersConfig } from '../config'
import { open, rename, unlink } from 'node:fs/promises'
import z from 'zod'
import { logger } from '../../logger'
import { requireInitialization } from '../decorators/require-initialization'
import { FetchError } from '../errors/FetchError'
import { IncompleteDownloadError } from '../errors/IncompleteDownloadError'
import { normalizeImdbId, Release } from '../release'
import { withSpan } from '../tracing'
import { ServerConnector } from './base'

const PeerSearchResponse = z.object({ items: z.array(Release) })
const MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024 * 1024 // 100GB
const DOWNLOAD_PROGRESS_INTERVAL_MS = 10_000
const DOWNLOAD_PROGRESS_BYTES = 64 * 1024 * 1024
const CONTENT_RANGE_PATTERN = /^bytes (\d+)-(\d+)\/(\d+)$/

export type PeerDownloadProgressEvent
  = | { type: 'headers', expectedBytes: number | null, expectedBytesSource: 'content_length' | null, expectedBytesMismatch: boolean }
    | { type: 'progress', downloadedBytes: number, expectedBytes: number | null }
    | { type: 'restart', reason: 'range_ignored' | 'content_range_mismatch' | 'range_not_satisfiable', discardedBytes: number }
    | { type: 'completed', downloadedBytes: number, expectedBytes: number | null }

export interface PeerDownloadOptions {
  timeoutMs?: number
  torrentFilename?: string
  partPath?: string
  releaseSize?: number
  onProgress?: (event: PeerDownloadProgressEvent) => void | Promise<void>
}

function parseContentLength(headers: Headers): number | null {
  const raw = headers.get('Content-Length')
  if (!raw)
    return null

  const parsed = Number(raw)
  if (!Number.isSafeInteger(parsed) || parsed < 0)
    return null

  return parsed
}

function parseContentRange(value: string | null): { start: number, end: number, total: number } | null {
  if (!value)
    return null
  const match = CONTENT_RANGE_PATTERN.exec(value.trim())
  if (!match)
    return null
  const start = Number(match[1])
  const end = Number(match[2])
  const total = Number(match[3])
  if (![start, end, total].every(Number.isSafeInteger))
    return null
  return { start, end, total }
}

/**
 * A connector to another jack instance (a "peer"). Sources only: we fan out
 * searches to it over the /peer API and stream files it serves. It speaks in
 * `Release`s, just like a local arr source.
 */
export class PeerConnector extends ServerConnector {
  constructor(config: { url: string, apiKey: string, name: string, headers?: ConnectorHeadersConfig }) {
    super({
      pingPath: '/peer/search',
      pingMethod: 'GET',
      authHeader: 'X-Api-Key',
    }, { ...config, type: 'jack' })
  }

  override get authHeaderValue() {
    return this.apiKey
  }

  protected override async runInit(): Promise<void> {
    await withSpan('peer.init', {
      'peer.name': this.name,
      'peer.id': this.id,
      'server.url': this.url,
    }, async (span) => {
      await this.ping()
      span.setAttribute('peer.initialized', true)
      logger.debug(`Connected to Jack peer ${this.name}`)
    })
  }

  @requireInitialization
  async searchByImdbId(imdbId: string): Promise<Release[]> {
    return withSpan('peer.search_by_imdb', {
      'peer.name': this.name,
      'peer.id': this.id,
      'search.imdb_id': imdbId,
    }, async (span) => {
      const { items } = await this.fetch('/peer/search', { method: 'GET', query: { imdbId }, schema: PeerSearchResponse })
      // Defensive: an older/over-eager peer may return more than asked (e.g. its
      // whole catalog), so keep only the releases that actually match the id.
      const target = normalizeImdbId(imdbId)
      const matched = items.filter(r => r.imdbId != null && normalizeImdbId(r.imdbId) === target)
      span.setAttributes({ 'release.returned_count': items.length, 'release.matched_count': matched.length })
      return matched
    })
  }

  @requireInitialization
  async searchByTmdbId(tmdbId: string): Promise<Release[]> {
    return withSpan('peer.search_by_tmdb', {
      'peer.name': this.name,
      'peer.id': this.id,
      'search.tmdb_id': tmdbId,
    }, async (span) => {
      const { items } = await this.fetch('/peer/search', { method: 'GET', query: { tmdbId }, schema: PeerSearchResponse })
      const matched = items.filter(r => r.tmdbId != null && String(r.tmdbId) === tmdbId)
      span.setAttributes({ 'release.returned_count': items.length, 'release.matched_count': matched.length })
      return matched
    })
  }

  /** Full catalog of the peer's releases (no filter) — used for the RSS feed. */
  @requireInitialization
  async listReleases(): Promise<Release[]> {
    return withSpan('peer.catalog', {
      'peer.name': this.name,
      'peer.id': this.id,
    }, async (span) => {
      const { items } = await this.fetch('/peer/search', { method: 'GET', schema: PeerSearchResponse })
      span.setAttribute('release.count', items.length)
      return items
    })
  }

  @requireInitialization
  async searchByTvdbId(tvdbId: string, season?: number, episode?: number): Promise<Release[]> {
    return withSpan('peer.search_by_tvdb', {
      'peer.name': this.name,
      'peer.id': this.id,
      'search.tvdb_id': tvdbId,
      'search.season': season,
      'search.episode': episode,
    }, async (span) => {
      const query: Record<string, string> = { tvdbId }
      if (season != null)
        query.season = String(season)
      if (episode != null)
        query.episode = String(episode)
      const { items } = await this.fetch('/peer/search', { method: 'GET', query, schema: PeerSearchResponse })
      const matched = items.filter(r =>
        r.tvdbId != null && String(r.tvdbId) === tvdbId
        && (season == null || r.season === season)
        && (episode == null || r.episode === episode))
      span.setAttributes({ 'release.returned_count': items.length, 'release.matched_count': matched.length })
      return matched
    })
  }

  @requireInitialization
  async getRelease(id: string): Promise<Release> {
    return this.fetch(`/peer/items/${encodeURIComponent(id)}`, { method: 'GET', schema: Release })
  }

  @requireInitialization
  async downloadFile(id: string, destPath: string, options: PeerDownloadOptions = {}): Promise<void> {
    return withSpan('peer.download_file', {
      'peer.name': this.name,
      'peer.id': this.id,
      'item.id': id,
      'torrent.filename': options.torrentFilename,
    }, async (span) => {
      const timeoutMs = options.timeoutMs ?? 30 * 60 * 1000
      const torrentFilename = options.torrentFilename
      const url = new URL(`/peer/items/${encodeURIComponent(id)}/file`, this.url)
      const partPath = options.partPath ?? `${destPath}.part`
      const baseHeaders = { ...this.headers, 'X-Api-Key': this.apiKey }
      span.setAttributes({ 'http.request.timeout_ms': timeoutMs, 'url.path': url.pathname })

      const partFile = Bun.file(partPath)
      let existingBytes = await partFile.exists() ? partFile.size : 0

      const doFetch = (withRange: boolean) => fetch(url, {
        headers: withRange ? { ...baseHeaders, Range: `bytes=${existingBytes}-` } : baseHeaders,
        signal: AbortSignal.timeout(timeoutMs),
      })

      const emitRestart = async (reason: 'range_ignored' | 'content_range_mismatch' | 'range_not_satisfiable', discardedBytes: number) => {
        logger.warn({ id, torrentFilename, partPath, discardedBytes, reason, peer: this.name }, 'Resume validation failed; restarting download from byte 0')
        try {
          await options.onProgress?.({ type: 'restart', reason, discardedBytes })
        }
        catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          logger.error({ id, torrentFilename, reason, error: message }, 'Restart progress callback failed')
        }
      }

      const restartFresh = async (response: Response, reason: 'content_range_mismatch' | 'range_not_satisfiable', discardedBytes: number): Promise<Response> => {
        // Discard the unwanted partial response. Don't await the cancel: under
        // some fetch/stream implementations a closed body's cancel() never
        // settles, which would stall the restart.
        void response.body?.cancel().catch(() => {})
        await unlink(partPath).catch(() => {})
        existingBytes = 0
        await emitRestart(reason, discardedBytes)
        return doFetch(false)
      }

      let response = await doFetch(existingBytes > 0)
      span.setAttribute('http.response.status_code', response.status)

      if (existingBytes > 0) {
        if (response.status === 206) {
          const cr = parseContentRange(response.headers.get('Content-Range'))
          const valid = cr != null && cr.start === existingBytes
            && (options.releaseSize == null || cr.total === options.releaseSize)
          if (!valid) {
            response = await restartFresh(response, 'content_range_mismatch', existingBytes)
            span.setAttribute('http.response.status_code', response.status)
          }
        }
        else if (response.status === 416) {
          response = await restartFresh(response, 'range_not_satisfiable', existingBytes)
          span.setAttribute('http.response.status_code', response.status)
        }
        else if (!response.ok) {
          throw new FetchError(`Failed to resume download from peer: ${response.statusText}`, response)
        }
        else if (response.ok) {
          // Peer ignored the Range header and is streaming the whole file from
          // byte 0. Discard the stale .part and use this response as-is.
          const discarded = existingBytes
          await unlink(partPath).catch(() => {})
          existingBytes = 0
          await emitRestart('range_ignored', discarded)
        }
      }

      const resuming = existingBytes > 0

      if (resuming) {
        // We only reach here with a 206 that was already validated above.
      }
      else {
        // Fresh download: require a clean 200. A 206 here is untrustworthy — we
        // did not send a satisfiable Range, so a partial body must not be
        // treated as the whole file (it would rename a truncated file into place).
        if (!response.ok)
          throw new FetchError(`Failed to download file from peer: ${response.statusText}`, response)
        if (response.status === 206)
          throw new Error('Peer returned 206 Partial Content for a non-range request')
      }

      if (!response.body)
        throw new Error('Peer returned a file response without a body')

      // Total file size: from Content-Range on a resume (206), else Content-Length.
      const expectedBytes = resuming
        ? parseContentRange(response.headers.get('Content-Range'))?.total ?? null
        : parseContentLength(response.headers)
      const expectedBytesMismatch = expectedBytes != null && options.releaseSize != null && expectedBytes !== options.releaseSize
      if (expectedBytes != null)
        span.setAttribute('download.expected_bytes', expectedBytes)
      span.setAttributes({
        'download.resuming': resuming,
        'download.resume_from_bytes': existingBytes,
        'download.expected_bytes_source': expectedBytes == null ? 'unknown' : 'content_length',
        'download.expected_bytes_mismatch': expectedBytesMismatch,
      })

      if (expectedBytesMismatch) {
        logger.warn({ id, torrentFilename, releaseSize: options.releaseSize, expectedBytes, peer: this.name }, 'Peer file total size differs from release metadata size')
      }

      await options.onProgress?.({
        type: 'headers',
        expectedBytes,
        expectedBytesSource: expectedBytes == null ? null : 'content_length',
        expectedBytesMismatch,
      })

      if (expectedBytes != null && expectedBytes > MAX_DOWNLOAD_BYTES)
        throw new Error(`File too large: ${expectedBytes} bytes exceeds ${MAX_DOWNLOAD_BYTES} byte limit`)

      const handle = await open(partPath, resuming ? 'a' : 'w')
      const reader = response.body.getReader()
      let downloadedBytes = existingBytes
      let lastLoggedAt = Date.now()
      let lastLoggedBytes = downloadedBytes
      let handleClosed = false

      const closeHandle = async () => {
        if (handleClosed)
          return
        handleClosed = true
        await handle.close().catch(() => {})
      }

      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done)
            break
          if (!value)
            continue

          downloadedBytes += value.byteLength
          if (downloadedBytes > MAX_DOWNLOAD_BYTES)
            throw new Error(`File too large: downloaded ${downloadedBytes} bytes exceeds ${MAX_DOWNLOAD_BYTES} byte limit`)

          await handle.write(value)

          const now = Date.now()
          const shouldLogProgress = downloadedBytes - lastLoggedBytes >= DOWNLOAD_PROGRESS_BYTES || now - lastLoggedAt >= DOWNLOAD_PROGRESS_INTERVAL_MS
          if (lastLoggedBytes === existingBytes || shouldLogProgress) {
            await handle.datasync().catch(() => {})
            logger.debug({ id, torrentFilename, destPath, partPath, downloadedBytes, expectedBytes, peer: this.name }, 'Download progress from peer')
            await options.onProgress?.({ type: 'progress', downloadedBytes, expectedBytes })
            lastLoggedAt = now
            lastLoggedBytes = downloadedBytes
          }
        }

        await handle.datasync().catch(() => {})
        await closeHandle()
        reader.releaseLock()

        if (expectedBytes != null && downloadedBytes !== expectedBytes)
          throw new IncompleteDownloadError(`Incomplete file download: got ${downloadedBytes} bytes, expected ${expectedBytes}`)

        await rename(partPath, destPath)
        span.setAttribute('download.downloaded_bytes', downloadedBytes)
        try {
          await options.onProgress?.({ type: 'completed', downloadedBytes, expectedBytes })
        }
        catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          logger.error({ id, torrentFilename, destPath, downloadedBytes, expectedBytes, peer: this.name, error: message }, 'Completed download progress callback failed')
        }
      }
      catch (err) {
        await closeHandle()
        try {
          reader.releaseLock()
        }
        catch {}
        // Leave the .part file in place so the next attempt can resume from the
        // durable bytes written so far. The atomic rename above means an
        // incomplete download never reaches `destPath`.
        throw err
      }
    })
  }
}
