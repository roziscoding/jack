import type { ConnectorHeadersConfig } from '../config'
import { open, rename, unlink } from 'node:fs/promises'
import z from 'zod'
import { logger } from '../../logger'
import { requiresInitialization } from '../decorators/requires-initialization'
import { FetchError } from '../errors/FetchError'
import { IdleTimeoutError } from '../errors/IdleTimeoutError'
import { IncompatiblePeerError } from '../errors/IncompatiblePeerError'
import { IncompleteDownloadError } from '../errors/IncompleteDownloadError'
import { UnknownSizeError } from '../errors/UnknownSizeError'
import { normalizeImdbId, Release } from '../release'
import { setSpanAttribute, setSpanAttributes } from '../span-attributes'
import { withSpan } from '../tracing'
import { isPeerVersionCompatible, MIN_PEER_PROTOCOL_VERSION } from '../version'
import { ServerConnector } from './base'

const PeerSearchResponse = z.object({ items: z.array(Release) })
const MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024 * 1024 // 100GB
const DOWNLOAD_PROGRESS_INTERVAL_MS = 10_000
const DOWNLOAD_PROGRESS_BYTES = 64 * 1024 * 1024
const CONTENT_RANGE_PATTERN = /^bytes (\d+)-(\d+)\/(\d+)$/

export type PeerDownloadProgressEvent
  = | { type: 'headers', expectedBytes: number | null, expectedBytesSource: 'content_length' | 'content_range' | 'release_size' | null, expectedBytesMismatch: boolean }
    | { type: 'progress', downloadedBytes: number, expectedBytes: number | null }
    | { type: 'restart', reason: 'range_ignored' | 'content_range_mismatch' | 'range_not_satisfiable' | 'part_oversize', discardedBytes: number }
    | { type: 'completed', downloadedBytes: number, expectedBytes: number | null }

export interface PeerDownloadOptions {
  signal?: AbortSignal
  idleTimeoutMs?: number
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
  private _peerVersion: string | null = null

  constructor(config: { url: string, apiKey: string, name: string, headers?: ConnectorHeadersConfig }) {
    super({
      pingPath: '/handshake',
      pingMethod: 'GET',
      authHeader: 'X-Api-Key',
    }, { ...config, type: 'jack' })

    // The peer API key rides in the X-Api-Key header; over plain HTTP it's exposed
    // in transit to anything on the path. Warn so the operator can switch to https.
    if (config.url.startsWith('http://')) {
      logger.warn(
        { peer: { name: config.name, url: config.url } },
        `Peer "${config.name}" is configured over plain HTTP — its API key is sent in cleartext. Use an https:// URL where possible.`,
      )
    }
  }

  override get authHeaderValue() {
    return this.apiKey
  }

  /** The peer's reported protocol version, set on a successful handshake. */
  get peerVersion(): string | null {
    return this._peerVersion
  }

  protected override async runInit(): Promise<void> {
    await withSpan('peer.init', {
      'peer.name': this.name,
      'peer.id': this.id,
      'server.url': this.url,
    }, async (span) => {
      let handshake: unknown
      try {
        handshake = await this.ping()
      }
      catch (err) {
        // An old peer (pre-0.1.0) has no /handshake route → 404. Treat that as
        // an incompatible/unsupported protocol version rather than a generic
        // fetch failure, so the cause is unmistakable. Network/timeout/401/5xx
        // propagate unchanged (auth/connectivity stay distinct from version).
        if (err instanceof FetchError && err.response.status === 404) {
          throw new IncompatiblePeerError(`Peer "${this.name}" runs an incompatible peer-protocol version: expected >= ${MIN_PEER_PROTOCOL_VERSION}, got none (no handshake endpoint)`)
        }
        throw err
      }

      // Read the version defensively: any non-string/missing value collapses to
      // `undefined` so a malformed or unversioned peer fails the same clean way.
      const version = typeof handshake === 'object' && handshake !== null && 'version' in handshake && typeof handshake.version === 'string'
        ? handshake.version
        : undefined
      if (!version || !isPeerVersionCompatible(version)) {
        throw new IncompatiblePeerError(`Peer "${this.name}" runs an incompatible peer-protocol version: expected >= ${MIN_PEER_PROTOCOL_VERSION}, got ${version || 'none'}`)
      }

      this._peerVersion = version
      setSpanAttributes(span, { 'peer.version': version, 'peer.initialized': true })
      logger.debug({ peer: this.name, version }, `Connected to Jack peer ${this.name}`)
    })
  }

  @requiresInitialization
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
      setSpanAttributes(span, { 'release.returned_count': items.length, 'release.matched_count': matched.length })
      return matched
    })
  }

  @requiresInitialization
  async searchByTmdbId(tmdbId: string): Promise<Release[]> {
    return withSpan('peer.search_by_tmdb', {
      'peer.name': this.name,
      'peer.id': this.id,
      'search.tmdb_id': tmdbId,
    }, async (span) => {
      const { items } = await this.fetch('/peer/search', { method: 'GET', query: { tmdbId }, schema: PeerSearchResponse })
      const matched = items.filter(r => r.tmdbId != null && String(r.tmdbId) === tmdbId)
      setSpanAttributes(span, { 'release.returned_count': items.length, 'release.matched_count': matched.length })
      return matched
    })
  }

  /** Full catalog of the peer's releases (no filter) — used for the RSS feed. */
  @requiresInitialization
  async listReleases(): Promise<Release[]> {
    return withSpan('peer.catalog', {
      'peer.name': this.name,
      'peer.id': this.id,
    }, async (span) => {
      const { items } = await this.fetch('/peer/search', { method: 'GET', schema: PeerSearchResponse })
      setSpanAttribute(span, 'release.count', items.length)
      return items
    })
  }

  @requiresInitialization
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
      setSpanAttributes(span, { 'release.returned_count': items.length, 'release.matched_count': matched.length })
      return matched
    })
  }

  @requiresInitialization
  async getRelease(id: string): Promise<Release> {
    return this.fetch(`/peer/items/${encodeURIComponent(id)}`, { method: 'GET', schema: Release })
  }

  @requiresInitialization
  async downloadFile(id: string, destPath: string, options: PeerDownloadOptions = {}): Promise<void> {
    return withSpan('peer.download_file', {
      'peer.name': this.name,
      'peer.id': this.id,
      'item.id': id,
      'torrent.filename': options.torrentFilename,
    }, async (span) => {
      const idleTimeoutMs = options.idleTimeoutMs ?? 60_000
      const torrentFilename = options.torrentFilename
      const url = new URL(`/peer/items/${encodeURIComponent(id)}/file`, this.url)
      const partPath = options.partPath ?? `${destPath}.part`
      const baseHeaders = { ...this.headers, 'X-Api-Key': this.apiKey }
      setSpanAttributes(span, { 'http.request.idle_timeout_ms': idleTimeoutMs, 'url.path': url.pathname })

      // Idle (inactivity) timeout, armed ONLY around network waits (fetch + each
      // read) and cleared before local file/progress work, so slow disk I/O never
      // trips it. The abort carries a sentinel reason so only it — not a later real
      // error — is reclassified as a retryable IdleTimeoutError.
      const controller = new AbortController()
      const signal = options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal
      const IDLE_ABORT_REASON = 'jack:idle-timeout'
      let idleTimer: ReturnType<typeof setTimeout> | undefined
      const clearIdle = () => {
        if (idleTimer) {
          clearTimeout(idleTimer)
          idleTimer = undefined
        }
      }
      const armIdle = () => {
        clearIdle()
        idleTimer = setTimeout(() => controller.abort(IDLE_ABORT_REASON), idleTimeoutMs)
        idleTimer.unref?.()
      }
      const isIdleAbort = () => controller.signal.aborted && controller.signal.reason === IDLE_ABORT_REASON
      const idleTimeout = () => new IdleTimeoutError(`Peer download stalled: no data received for ${idleTimeoutMs}ms`)

      const partFile = Bun.file(partPath)
      let existingBytes = await partFile.exists() ? partFile.size : 0

      const doFetch = async (withRange: boolean): Promise<Response> => {
        signal.throwIfAborted()
        armIdle()
        try {
          return await fetch(url, {
            headers: withRange ? { ...baseHeaders, Range: `bytes=${existingBytes}-` } : baseHeaders,
            signal,
          })
        }
        catch (err) {
          if (isIdleAbort())
            throw idleTimeout()
          throw err
        }
        finally {
          clearIdle()
        }
      }

      const emitRestart = async (reason: 'range_ignored' | 'content_range_mismatch' | 'range_not_satisfiable' | 'part_oversize', discardedBytes: number) => {
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

      // Resume sanity vs the known release size (available before the request):
      // a .part larger than the whole file is corrupt → discard; a .part already
      // equal to the file is complete → finalize without re-downloading.
      if (existingBytes > 0 && options.releaseSize != null) {
        if (existingBytes > options.releaseSize) {
          await unlink(partPath).catch(() => {})
          await emitRestart('part_oversize', existingBytes)
          existingBytes = 0
        }
        else if (existingBytes === options.releaseSize) {
          signal.throwIfAborted()
          await rename(partPath, destPath)
          setSpanAttribute(span, 'download.downloaded_bytes', existingBytes)
          // Emit headers too so the service persists expectedBytes/source (the
          // fast path otherwise skips the headers event).
          await options.onProgress?.({ type: 'headers', expectedBytes: options.releaseSize, expectedBytesSource: 'release_size', expectedBytesMismatch: false })
          await options.onProgress?.({ type: 'completed', downloadedBytes: existingBytes, expectedBytes: options.releaseSize })
          return
        }
      }

      let response = await doFetch(existingBytes > 0)
      setSpanAttribute(span, 'http.response.status_code', response.status)

      if (existingBytes > 0) {
        if (response.status === 206) {
          const cr = parseContentRange(response.headers.get('Content-Range'))
          const valid = cr != null && cr.start === existingBytes
            && (options.releaseSize == null || cr.total === options.releaseSize)
          if (!valid) {
            response = await restartFresh(response, 'content_range_mismatch', existingBytes)
            setSpanAttribute(span, 'http.response.status_code', response.status)
          }
        }
        else if (response.status === 416) {
          response = await restartFresh(response, 'range_not_satisfiable', existingBytes)
          setSpanAttribute(span, 'http.response.status_code', response.status)
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

      // Expected total size: the transfer header (Content-Range total on resume,
      // else Content-Length), falling back to the *arr release size. Fail-fast if
      // none is known — we never import a file we can't size-check.
      const transferSize = resuming
        ? parseContentRange(response.headers.get('Content-Range'))?.total ?? null
        : parseContentLength(response.headers)
      const expectedBytes = transferSize ?? options.releaseSize ?? null
      // Source = where the TRANSFER advertised the size: Content-Range on a resume
      // (206), else Content-Length; 'release_size' means it came only from *arr
      // metadata (the peer advertised no size).
      const expectedBytesSource: 'content_length' | 'content_range' | 'release_size' | null
        = transferSize != null ? (resuming ? 'content_range' : 'content_length') : (expectedBytes != null ? 'release_size' : null)
      const expectedBytesMismatch = transferSize != null && options.releaseSize != null && transferSize !== options.releaseSize
      setSpanAttributes(span, {
        'download.resuming': resuming,
        'download.resume_from_bytes': existingBytes,
        'download.expected_bytes_source': expectedBytesSource ?? 'unknown',
        'download.expected_bytes_mismatch': expectedBytesMismatch,
      })

      if (expectedBytes == null) {
        void response.body.cancel().catch(() => {})
        throw new UnknownSizeError(`Cannot verify download for item ${id}: no Content-Length/Content-Range and no release size`)
      }
      setSpanAttribute(span, 'download.expected_bytes', expectedBytes)

      if (expectedBytesMismatch) {
        logger.warn({ id, torrentFilename, releaseSize: options.releaseSize, expectedBytes: transferSize, peer: this.name }, 'Peer file total size differs from release metadata size')
      }

      await options.onProgress?.({
        type: 'headers',
        expectedBytes,
        expectedBytesSource,
        expectedBytesMismatch,
      })

      if (expectedBytes > MAX_DOWNLOAD_BYTES)
        throw new Error(`File too large: ${expectedBytes} bytes exceeds ${MAX_DOWNLOAD_BYTES} byte limit`)

      const handle = await open(partPath, resuming ? 'a' : 'w')
      let reader: ReadableStreamDefaultReader<Uint8Array>
      try {
        reader = response.body.getReader() as ReadableStreamDefaultReader<Uint8Array>
      }
      catch (err) {
        await handle.close().catch(() => {})
        throw err
      }
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
          // Arm the idle timer only for the network read; clear it immediately
          // after so disk writes / progress callbacks don't count as "idle".
          armIdle()
          let done: boolean
          let value: Uint8Array | undefined
          try {
            const result = await reader.read()
            done = result.done
            value = result.value
          }
          finally {
            clearIdle()
          }
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

        // Release the lock only after the completeness check passes, so the catch
        // block's cancel+release runs against a still-locked reader on the
        // IncompleteDownloadError path (which is the one that gets retried).
        if (downloadedBytes !== expectedBytes)
          throw new IncompleteDownloadError(`Incomplete file download: got ${downloadedBytes} bytes, expected ${expectedBytes}`)
        reader.releaseLock()

        signal.throwIfAborted()
        await rename(partPath, destPath)
        setSpanAttribute(span, 'download.downloaded_bytes', downloadedBytes)
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
        // Cancel the reader so the remote stream is torn down (not left to GC),
        // then release. Leave the .part in place so the next attempt resumes.
        await reader.cancel().catch(() => {})
        try {
          reader.releaseLock()
        }
        catch {}
        if (isIdleAbort())
          throw idleTimeout()
        throw err
      }
    })
  }
}
