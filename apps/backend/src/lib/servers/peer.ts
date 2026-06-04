import type { ConnectorHeadersConfig } from '../config'
import { rename, unlink } from 'node:fs/promises'
import z from 'zod'
import { logger } from '../../logger'
import { requireInitialization } from '../decorators/require-initialization'
import { FetchError } from '../errors/FetchError'
import { normalizeImdbId, Release } from '../release'
import { withSpan } from '../tracing'
import { ServerConnector } from './base'

const PeerSearchResponse = z.object({ items: z.array(Release) })
const MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024 * 1024 // 100GB
const DOWNLOAD_PROGRESS_INTERVAL_MS = 10_000
const DOWNLOAD_PROGRESS_BYTES = 64 * 1024 * 1024

export type PeerDownloadProgressEvent
  = | { type: 'headers', expectedBytes: number | null, expectedBytesSource: 'content_length' | null, expectedBytesMismatch: boolean }
    | { type: 'progress', downloadedBytes: number, expectedBytes: number | null }
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
      span.setAttributes({
        'http.request.timeout_ms': timeoutMs,
        'url.path': url.pathname,
      })

      const response = await fetch(url, {
        headers: { ...this.headers, 'X-Api-Key': this.apiKey },
        signal: AbortSignal.timeout(timeoutMs),
      })

      span.setAttribute('http.response.status_code', response.status)

      if (!response.ok) {
        throw new FetchError(`Failed to download file from peer: ${response.statusText}`, response)
      }

      if (!response.body) {
        throw new Error('Peer returned a file response without a body')
      }

      const expectedBytes = parseContentLength(response.headers)
      const expectedBytesMismatch = expectedBytes != null && options.releaseSize != null && expectedBytes !== options.releaseSize
      if (expectedBytes != null)
        span.setAttribute('download.expected_bytes', expectedBytes)
      span.setAttribute('download.expected_bytes_source', expectedBytes == null ? 'unknown' : 'content_length')
      span.setAttribute('download.expected_bytes_mismatch', expectedBytesMismatch)

      if (expectedBytesMismatch) {
        logger.warn({
          id,
          torrentFilename,
          releaseSize: options.releaseSize,
          expectedBytes,
          peer: this.name,
        }, 'Peer file Content-Length differs from release metadata size')
      }

      await options.onProgress?.({
        type: 'headers',
        expectedBytes,
        expectedBytesSource: expectedBytes == null ? null : 'content_length',
        expectedBytesMismatch,
      })

      if (expectedBytes != null && expectedBytes > MAX_DOWNLOAD_BYTES)
        throw new Error(`File too large: ${expectedBytes} bytes exceeds ${MAX_DOWNLOAD_BYTES} byte limit`)

      const reader = response.body.getReader()
      const writer = Bun.file(partPath).writer()
      let downloadedBytes = 0
      let lastLoggedAt = Date.now()
      let lastLoggedBytes = 0
      let writerEnded = false

      const endWriter = () => {
        if (writerEnded)
          return
        writer.end()
        writerEnded = true
      }

      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done)
            break
          if (!value)
            continue

          downloadedBytes += value.byteLength
          if (downloadedBytes > MAX_DOWNLOAD_BYTES) {
            throw new Error(`File too large: downloaded ${downloadedBytes} bytes exceeds ${MAX_DOWNLOAD_BYTES} byte limit`)
          }

          writer.write(value)

          const now = Date.now()
          const shouldLogProgress = downloadedBytes - lastLoggedBytes >= DOWNLOAD_PROGRESS_BYTES || now - lastLoggedAt >= DOWNLOAD_PROGRESS_INTERVAL_MS
          if (lastLoggedBytes === 0 || shouldLogProgress) {
            await writer.flush()
            logger.debug({ id, torrentFilename, destPath, partPath, downloadedBytes, expectedBytes, peer: this.name }, 'Download progress from peer')
            await options.onProgress?.({ type: 'progress', downloadedBytes, expectedBytes })
            lastLoggedAt = now
            lastLoggedBytes = downloadedBytes
          }
        }

        endWriter()
        reader.releaseLock()

        if (expectedBytes != null && downloadedBytes !== expectedBytes)
          throw new Error(`Incomplete file download: got ${downloadedBytes} bytes, expected ${expectedBytes}`)

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
        try {
          endWriter()
        }
        catch {}
        try {
          reader.releaseLock()
        }
        catch {}
        await unlink(partPath).catch(() => {})
        throw err
      }
    })
  }
}
