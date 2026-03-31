import type { BaseItemDto } from '@jack/schemas/jellyfin/types'
import { FetchError } from '../../errors/FetchError'
import { SourceServerConnector } from './base'
import { logger } from '../../../logger'

export class JackServerConnector extends SourceServerConnector<BaseItemDto> {
  constructor(config: { url: string, apiKey: string, name?: string }) {
    super({
      pingPath: '/peer/search',
      pingMethod: 'GET',
      authHeader: 'X-Api-Key',
    }, { ...config, type: 'jack' as any })
  }

  override get authHeaderValue() {
    return this.apiKey
  }

  override init() {
    this._initialization = Promise.withResolvers()

    this.ping()
      .then(() => {
        logger.debug(`Connected to Jack peer ${this.name ?? this.url}`)
        this._isInitialized = true
        this._initialization?.resolve()
      })
      .catch((err) => {
        const message = err instanceof Error ? err.message : String(err)
        this._initializationError = message
        this._initialization?.reject(err)
      })
  }

  private async peerFetch<T>(path: string, query?: Record<string, string>): Promise<T> {
    const url = new URL(path, this.url)
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        url.searchParams.set(key, value)
      }
    }

    const response = await fetch(url, {
      headers: { 'X-Api-Key': this.apiKey },
    })

    if (!response.ok) {
      throw new FetchError(`Peer request failed: ${response.statusText}`, response)
    }

    return response.json() as Promise<T>
  }

  async searchItems(searchTerm: string) {
    const result = await this.peerFetch<{ items: BaseItemDto[] }>('/peer/search', { q: searchTerm })
    return result.items
  }

  async searchByImdbId(imdbId: string) {
    const result = await this.peerFetch<{ items: BaseItemDto[] }>('/peer/search', { imdbId })
    return result.items
  }

  async searchByTvdbId(tvdbId: string, season?: number, episode?: number) {
    const query: Record<string, string> = { tvdbId }
    if (season != null) query.season = String(season)
    if (episode != null) query.episode = String(episode)
    const result = await this.peerFetch<{ items: BaseItemDto[] }>('/peer/search', query)
    return result.items
  }

  async getItemMetadata(itemId: string) {
    return this.peerFetch<BaseItemDto>(`/peer/items/${itemId}`)
  }

  async downloadFile(itemId: string, destPath: string, timeoutMs = 30 * 60 * 1000): Promise<void> {
    const url = new URL(`/peer/items/${itemId}/file`, this.url)
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
    logger.info({ itemId, destPath, size: contentLength, peer: this.name ?? this.url }, 'Downloaded file from peer')
  }
}
