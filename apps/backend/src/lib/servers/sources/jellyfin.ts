import { createJellyfinClient } from '@jack/schemas/jellyfin'
import type { BaseItemDto } from '@jack/schemas/jellyfin/types'
import { FetchError } from '../../errors/FetchError'
import { SourceServerConnector } from './base'
import { schemas } from '@jack/schemas/jellyfin'
import { logger } from '../../../logger'

export class JellyfinServerConnector extends SourceServerConnector<BaseItemDto> {
  private readonly client = createJellyfinClient(this.url, this.apiKey)
  constructor(config: { url: string, apiKey: string, name?: string }) {
    super({
      pingPath: '/System/Info',
      pingMethod: 'GET',
      authHeader: 'Authorization',
    }, { ...config, type: 'jellyfin' })
  }

  override init() {
    this._initialization = Promise.withResolvers()
    this.ping(schemas.zSystemInfo)
      .then((info) => {
        if (info.ProductName !== 'Jellyfin Server') {
          this._initializationError = `Invalid appName "${info.ProductName}" found for server type ${this.type}. Expected "Jellyfin Server"`
          this._initialization?.reject(new Error(this._initializationError))
          return
        }

        logger.debug({ info }, `Found ${info.ProductName} ${info.Version}`) 
        this._isInitialized = true
        this._initialization?.resolve()
      })
      .catch((err) => {
        const message = err instanceof Error ? err.message : String(err)
        this._initialization?.reject(err)
        this._initializationError = message
      })
  }

  override get authHeaderValue() {
    return `MediaBrowser Token="${this.apiKey}", Device="Jack"`
  }

  async searchItems(searchTerm: string) {
    const result = await this.client.getItems({ searchTerm })

    if (!result.response.ok) {
      throw new FetchError(`Failed to fetch url: ${result.response.statusText}`, result.response)
    }

    return result.data?.Items ?? []
  }
}
