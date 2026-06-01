import type { DestinationServerType } from '../../config'
import z from 'zod'
import { logger } from '../../../logger'
import { requireInitialization } from '../../decorators/require-initialization'
import { ServerConnector } from '../base'

export const DestinationServerHealthIssue = z.array(
  z.object({
    id: z.number().int().optional(),
    source: z.string().nullable().optional(),
    type: z.enum(['ok', 'notice', 'warning', 'error']).optional(),
    message: z.string().nullable().optional(),
    wikiUrl: z
      .object({
        fullUri: z.string().nullable().optional(),
        scheme: z.string().nullable().optional(),
        host: z.string().nullable().optional(),
        port: z.number().int().nullable().optional(),
        path: z.string().nullable().optional(),
        query: z.string().nullable().optional(),
        fragment: z.string().nullable().optional(),
      })
      .optional(),
  }),
)

export class DestinationServerConnector extends ServerConnector {
  protected readonly expectedAppName: string

  constructor(connectorConfig: { pingPath: string, pingMethod: string, authHeader: string, authHeaderPrefix?: string, expectedAppName: string }, config: { type: DestinationServerType, url: string, apiKey: string, name?: string }) {
    super(connectorConfig, config)
    this.expectedAppName = connectorConfig.expectedAppName
  }

  override init(): void {
    this._initialization = Promise.withResolvers()

    this.ping(z.object({ appName: z.string(), version: z.string() }))
      .then((apiInfo) => {
        if (apiInfo.appName !== this.expectedAppName) {
          this._initialization?.reject(new Error(`Invalid appName "${apiInfo.appName}" found for server type ${this.type}. Expected ${this.expectedAppName}`))
          return
        }
        
        logger.debug({ apiInfo }, `Found ${apiInfo.appName} ${apiInfo.version}`)
        this._initialization?.resolve()
        this._isInitialized = true
      })
      .catch((err) => {
        const message = err instanceof Error ? err.message : String(err)
        this._initializationError = message
        this._initialization?.reject(err)
      })
  }

  @requireInitialization
  async getHealthIssues() {
    return this.fetch('/api/v3/health', { schema: z.array(DestinationServerHealthIssue) })
  }

  @requireInitialization
  async triggerImport(downloadPath: string) {
    await this.fetch('/api/v3/command', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: this.importCommandName, path: downloadPath }),
    } as any)
  }

  protected get importCommandName(): string {
    return 'DownloadedMoviesScan'
  }

  @requireInitialization
  async registerIndexer(indexerConfig: { name: string, baseUrl: string, apiKey: string, priority: number, categories: number[] }) {
    const existingIndexers = await this.fetch<any>('/api/v3/indexer', { method: 'GET' })
    const existing = Array.isArray(existingIndexers)
      ? existingIndexers.find((idx: any) =>
        idx.fields?.some((f: any) => f.name === 'baseUrl' && f.value === indexerConfig.baseUrl))
      : null

    const body = {
      name: indexerConfig.name,
      implementation: 'Torznab',
      implementationName: 'Torznab',
      configContract: 'TorznabSettings',
      enableRss: true,
      enableAutomaticSearch: true,
      enableInteractiveSearch: true,
      priority: indexerConfig.priority,
      fields: [
        { name: 'baseUrl', value: indexerConfig.baseUrl },
        { name: 'apiPath', value: '/api' },
        { name: 'apiKey', value: indexerConfig.apiKey },
        { name: 'categories', value: indexerConfig.categories },
        { name: 'minimumSeeders', value: 0 },
      ],
    }

    // forceSave: false keeps *arr's validation test on save. We deliberately do
    // NOT want to register when it fails — better to fail loudly (the caller logs
    // the *arr error) than to silently register a broken indexer.
    if (existing) {
      await this.fetch(`/api/v3/indexer/${existing.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...body, id: existing.id }),
        query: { forceSave: 'false' },
      } as any)
    } else {
      await this.fetch('/api/v3/indexer', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        query: { forceSave: 'false' },
      } as any)
    }
  }

  @requireInitialization
  async registerDownloadClient(clientConfig: { name: string, watchPath: string, completedPath: string, priority: number }) {
    const existingClients = await this.fetch<any>('/api/v3/downloadclient', { method: 'GET' })
    const existing = Array.isArray(existingClients)
      ? existingClients.find((client: any) =>
        client.fields?.some((f: any) => f.name === 'torrentFolder' && f.value === clientConfig.watchPath))
      : null

    const body = {
      name: clientConfig.name,
      enable: true,
      protocol: 'torrent',
      priority: clientConfig.priority,
      implementation: 'TorrentBlackhole',
      implementationName: 'Torrent Blackhole',
      configContract: 'TorrentBlackholeSettings',
      fields: [
        // *arr writes the stub .torrent here; jack's watcher picks it up.
        { name: 'torrentFolder', value: clientConfig.watchPath },
        // jack writes the finished file here; *arr scans it to import.
        { name: 'watchFolder', value: clientConfig.completedPath },
        { name: 'saveMagnetFiles', value: false },
        { name: 'readOnly', value: false },
      ],
    }

    // forceSave: false keeps *arr's folder-accessibility test on save. We
    // deliberately do NOT want to register when it fails — better to fail loudly
    // (the caller logs the *arr error) than to silently register a download
    // client whose watch/completed folders *arr can't actually reach.
    if (existing) {
      await this.fetch(`/api/v3/downloadclient/${existing.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...body, id: existing.id }),
        query: { forceSave: 'false' },
      } as any)
    } else {
      await this.fetch('/api/v3/downloadclient', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        query: { forceSave: 'false' },
      } as any)
    }
  }
}
