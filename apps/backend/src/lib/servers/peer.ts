import z from 'zod'
import { logger } from '../../logger'
import { FetchError } from '../errors/FetchError'
import { Release } from '../release'
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

  override init() {
    this._initialization = Promise.withResolvers()

    this.ping()
      .then(() => {
        logger.debug(`Connected to Jack peer ${this.name}`)
        this._isInitialized = true
        this._initialization?.resolve()
      })
      .catch((err) => {
        const message = err instanceof Error ? err.message : String(err)
        this._initializationError = message
        this._initialization?.reject(err)
      })
  }

  async searchItems(term: string): Promise<Release[]> {
    const { items } = await this.fetch('/peer/search', { method: 'GET', query: { q: term }, schema: PeerSearchResponse })
    return items
  }

  async searchByImdbId(imdbId: string): Promise<Release[]> {
    const { items } = await this.fetch('/peer/search', { method: 'GET', query: { imdbId }, schema: PeerSearchResponse })
    return items
  }

  async searchByTvdbId(tvdbId: string, season?: number, episode?: number): Promise<Release[]> {
    const query: Record<string, string> = { tvdbId }
    if (season != null)
      query.season = String(season)
    if (episode != null)
      query.episode = String(episode)
    const { items } = await this.fetch('/peer/search', { method: 'GET', query, schema: PeerSearchResponse })
    return items
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
