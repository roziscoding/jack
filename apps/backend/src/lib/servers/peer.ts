import { rename, unlink } from 'node:fs/promises'
import z from 'zod'
import { logger } from '../../logger'
import { requireInitialization } from '../decorators/require-initialization'
import { FetchError } from '../errors/FetchError'
import { normalizeImdbId, Release } from '../release'
import { ServerConnector } from './base'

const PeerSearchResponse = z.object({ items: z.array(Release) })
const MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024 * 1024 // 100GB
const DOWNLOAD_PROGRESS_INTERVAL_MS = 10_000
const DOWNLOAD_PROGRESS_BYTES = 64 * 1024 * 1024

export interface PeerDownloadOptions {
  timeoutMs?: number
  torrentFilename?: string
}

/**
 * A connector to another jack instance (a "peer"). Sources only: we fan out
 * searches to it over the /peer API and stream files it serves. It speaks in
 * `Release`s, just like a local arr source.
 */
export class PeerConnector extends ServerConnector {
  constructor(config: { url: string, apiKey: string, name: string }) {
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
    await this.ping()
    logger.debug(`Connected to Jack peer ${this.name}`)
  }

  @requireInitialization
  async searchByImdbId(imdbId: string): Promise<Release[]> {
    logger.debug({ peer: this.name, imdbId }, 'Asking peer for items by imdbId')
    const { items } = await this.fetch('/peer/search', { method: 'GET', query: { imdbId }, schema: PeerSearchResponse })
    // Defensive: an older/over-eager peer may return more than asked (e.g. its
    // whole catalog), so keep only the releases that actually match the id.
    const target = normalizeImdbId(imdbId)
    const matched = items.filter(r => r.imdbId != null && normalizeImdbId(r.imdbId) === target)
    logger.debug({ peer: this.name, imdbId, returned: items.length, matched: matched.length }, 'Peer answered (imdb search)')
    return matched
  }

  @requireInitialization
  async searchByTmdbId(tmdbId: string): Promise<Release[]> {
    logger.debug({ peer: this.name, tmdbId }, 'Asking peer for items by tmdbId')
    const { items } = await this.fetch('/peer/search', { method: 'GET', query: { tmdbId }, schema: PeerSearchResponse })
    const matched = items.filter(r => r.tmdbId != null && String(r.tmdbId) === tmdbId)
    logger.debug({ peer: this.name, tmdbId, returned: items.length, matched: matched.length }, 'Peer answered (tmdb search)')
    return matched
  }

  /** Full catalog of the peer's releases (no filter) — used for the RSS feed. */
  @requireInitialization
  async listReleases(): Promise<Release[]> {
    logger.debug({ peer: this.name }, 'Asking peer for its full catalog')
    const { items } = await this.fetch('/peer/search', { method: 'GET', schema: PeerSearchResponse })
    logger.debug({ peer: this.name, count: items.length }, 'Peer answered (catalog)')
    return items
  }

  @requireInitialization
  async searchByTvdbId(tvdbId: string, season?: number, episode?: number): Promise<Release[]> {
    const query: Record<string, string> = { tvdbId }
    if (season != null)
      query.season = String(season)
    if (episode != null)
      query.episode = String(episode)
    logger.debug({ peer: this.name, tvdbId, season, episode }, 'Asking peer for items by tvdbId')
    const { items } = await this.fetch('/peer/search', { method: 'GET', query, schema: PeerSearchResponse })
    const matched = items.filter(r =>
      r.tvdbId != null && String(r.tvdbId) === tvdbId
      && (season == null || r.season === season)
      && (episode == null || r.episode === episode))
    logger.debug({ peer: this.name, tvdbId, season, episode, returned: items.length, matched: matched.length }, 'Peer answered (tvdb search)')
    return matched
  }

  @requireInitialization
  async getRelease(id: string): Promise<Release> {
    return this.fetch(`/peer/items/${encodeURIComponent(id)}`, { method: 'GET', schema: Release })
  }

  @requireInitialization
  async downloadFile(id: string, destPath: string, options: PeerDownloadOptions = {}): Promise<void> {
    const timeoutMs = options.timeoutMs ?? 30 * 60 * 1000
    const torrentFilename = options.torrentFilename
    const url = new URL(`/peer/items/${encodeURIComponent(id)}/file`, this.url)
    const partPath = `${destPath}.part`
    const response = await fetch(url, {
      headers: { 'X-Api-Key': this.apiKey },
      signal: AbortSignal.timeout(timeoutMs),
    })

    if (!response.ok) {
      throw new FetchError(`Failed to download file from peer: ${response.statusText}`, response)
    }

    if (!response.body) {
      throw new Error('Peer returned a file response without a body')
    }

    const contentLength = Number(response.headers.get('Content-Length') || 0)
    if (contentLength > MAX_DOWNLOAD_BYTES) {
      throw new Error(`File too large: ${contentLength} bytes exceeds ${MAX_DOWNLOAD_BYTES} byte limit`)
    }

    logger.info({ id, torrentFilename, destPath, partPath, expectedBytes: contentLength, peer: this.name }, 'Download response received from peer')

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
          logger.info({ id, torrentFilename, destPath, partPath, downloadedBytes, expectedBytes: contentLength, peer: this.name }, 'Download progress from peer')
          lastLoggedAt = now
          lastLoggedBytes = downloadedBytes
        }
      }

      endWriter()
      reader.releaseLock()

      if (contentLength > 0 && downloadedBytes !== contentLength) {
        throw new Error(`Incomplete file download: got ${downloadedBytes} bytes, expected ${contentLength}`)
      }

      await rename(partPath, destPath)
      logger.info({ id, torrentFilename, destPath, size: downloadedBytes, peer: this.name }, 'Downloaded file from peer')
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
  }
}
