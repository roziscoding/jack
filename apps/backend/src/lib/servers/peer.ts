import z from 'zod'
import { logger } from '../../logger'
import { FetchError } from '../errors/FetchError'
import { normalizeImdbId, Release } from '../release'
import { ServerConnector } from './base'

const PeerSearchResponse = z.object({ items: z.array(Release) })

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

  async searchByTmdbId(tmdbId: string): Promise<Release[]> {
    logger.debug({ peer: this.name, tmdbId }, 'Asking peer for items by tmdbId')
    const { items } = await this.fetch('/peer/search', { method: 'GET', query: { tmdbId }, schema: PeerSearchResponse })
    const matched = items.filter(r => r.tmdbId != null && String(r.tmdbId) === tmdbId)
    logger.debug({ peer: this.name, tmdbId, returned: items.length, matched: matched.length }, 'Peer answered (tmdb search)')
    return matched
  }

  /** Full catalog of the peer's releases (no filter) — used for the RSS feed. */
  async listReleases(): Promise<Release[]> {
    logger.debug({ peer: this.name }, 'Asking peer for its full catalog')
    const { items } = await this.fetch('/peer/search', { method: 'GET', schema: PeerSearchResponse })
    logger.debug({ peer: this.name, count: items.length }, 'Peer answered (catalog)')
    return items
  }

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

  async getRelease(id: string): Promise<Release> {
    return this.fetch(`/peer/items/${encodeURIComponent(id)}`, { method: 'GET', schema: Release })
  }

  async downloadFile(id: string, destPath: string, timeoutMs = 30 * 60 * 1000): Promise<void> {
    const url = new URL(`/peer/items/${encodeURIComponent(id)}/file`, this.url)
    const response = await fetch(url, {
      headers: { 'X-Api-Key': this.apiKey },
      signal: AbortSignal.timeout(timeoutMs),
    })

    if (!response.ok) {
      throw new FetchError(`Failed to download file from peer: ${response.statusText}`, response)
    }

    const contentLength = Number(response.headers.get('Content-Length') || 0)
    const maxSize = 100 * 1024 * 1024 * 1024 // 100GB
    if (contentLength > maxSize) {
      throw new Error(`File too large: ${contentLength} bytes exceeds ${maxSize} byte limit`)
    }

    await Bun.write(destPath, response)
    logger.info({ id, destPath, size: contentLength, peer: this.name }, 'Downloaded file from peer')
  }
}
