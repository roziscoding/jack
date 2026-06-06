import type { AutoRegisterConfig, ConnectorHeadersConfig, ServerType } from '../../config'
import type { Release } from '../../release'
import z from 'zod'
import { logger } from '../../../logger'
import { requireInitialization } from '../../decorators/require-initialization'
import { requiresDestination, requiresSource } from '../../decorators/requires-capability'
import { ServerConnector } from '../base'

const BASENAME_SEPARATOR_REGEX = /[/\\]/
const TRAILING_SLASH_REGEX = /\/$/

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

// *arr returns the saved download client on create; we only need its id to bind
// the auto-registered indexer to it.
const DownloadClientResource = z.object({ id: z.number().int() })

export type ReleaseKind = 'movie' | 'episode'

export function basename(path: string): string {
  return path.split(BASENAME_SEPARATOR_REGEX).pop() ?? path
}

export function stripExtension(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(0, dot) : name
}

/**
 * A single connector for a Radarr/Sonarr server. It can act as a **source** (its
 * library is exposed to peers) and/or a **destination** (jack registers itself
 * there and triggers imports), gated by the `source`/`destination` config flags.
 * Role-specific methods are guarded by `@requiresSource` / `@requiresDestination`.
 *
 * Subclasses implement the *arr-specific query logic (movie vs series/episode)
 * via the `do*` methods; the public methods here centralize the guards.
 */
export abstract class ArrServerConnector extends ServerConnector {
  public readonly canSource: boolean
  public readonly canDestination: boolean
  public readonly autoRegister: AutoRegisterConfig
  protected readonly expectedAppName: string

  constructor(
    connectorConfig: { pingPath: string, pingMethod: string, authHeader: string, expectedAppName: string },
    config: { type: ServerType, url: string, apiKey: string, name: string, source: boolean, destination: boolean, autoregister: AutoRegisterConfig, headers?: ConnectorHeadersConfig },
  ) {
    super(connectorConfig, config)
    this.expectedAppName = connectorConfig.expectedAppName
    this.canSource = config.source
    this.canDestination = config.destination
    this.autoRegister = config.autoregister
  }

  // Category id reported to *arr (2000 movies / 5000 tv).
  abstract get categories(): number[]
  // qBittorrent settings use a per-app category field name.
  protected abstract get qbCategoryFieldName(): string

  protected override async runInit(): Promise<void> {
    const apiInfo = await this.ping(z.object({ appName: z.string(), version: z.string() }))
    if (apiInfo.appName !== this.expectedAppName) {
      throw new Error(`Invalid appName "${apiInfo.appName}" found for server type ${this.type}. Expected ${this.expectedAppName}`)
    }
    logger.debug({ apiInfo }, `Found ${apiInfo.appName} ${apiInfo.version}`)
  }

  /** GET an *arr endpoint and return the parsed JSON, typed by the caller. */
  protected async arrGet<T>(path: string, query?: Record<string, string>): Promise<T> {
    return (await this.fetch(path, { method: 'GET', query })) as T
  }

  /** `${connectorId}:${kind}:${entityId}` — globally identifies a release. */
  protected buildId(kind: ReleaseKind, entityId: number | string): string {
    return `${this.id}:${kind}:${entityId}`
  }

  /** Parse the entity id out of a release id, or null if it isn't ours. */
  protected parseId(id: string): { kind: ReleaseKind, entityId: string } | null {
    const [connectorId, kind, ...rest] = id.split(':')
    if (connectorId !== this.id || (kind !== 'movie' && kind !== 'episode') || rest.length === 0) {
      return null
    }
    return { kind, entityId: rest.join(':') }
  }

  // ---- Source role ----

  @requiresSource
  @requireInitialization
  async searchItems(term: string): Promise<Release[]> {
    return this.doSearchItems(term)
  }

  @requiresSource
  @requireInitialization
  async searchByImdbId(imdbId: string): Promise<Release[]> {
    return this.doSearchByImdbId(imdbId)
  }

  @requiresSource
  @requireInitialization
  async searchByTmdbId(tmdbId: string): Promise<Release[]> {
    return this.doSearchByTmdbId(tmdbId)
  }

  @requiresSource
  @requireInitialization
  async searchByTvdbId(tvdbId: string, season?: number, episode?: number): Promise<Release[]> {
    return this.doSearchByTvdbId(tvdbId, season, episode)
  }

  /** All releases this source can serve — used for the torznab RSS/catalog feed. */
  @requiresSource
  @requireInitialization
  async listReleases(): Promise<Release[]> {
    return this.doListReleases()
  }

  @requiresSource
  @requireInitialization
  async getRelease(id: string): Promise<Release | null> {
    return this.doGetRelease(id)
  }

  @requiresSource
  @requireInitialization
  async getFilePath(id: string): Promise<string | null> {
    return this.doGetFilePath(id)
  }

  protected abstract doSearchItems(term: string): Promise<Release[]>
  protected abstract doSearchByImdbId(imdbId: string): Promise<Release[]>
  protected abstract doSearchByTmdbId(tmdbId: string): Promise<Release[]>
  protected abstract doSearchByTvdbId(tvdbId: string, season?: number, episode?: number): Promise<Release[]>
  protected abstract doListReleases(): Promise<Release[]>
  protected abstract doGetRelease(id: string): Promise<Release | null>
  protected abstract doGetFilePath(id: string): Promise<string | null>

  // ---- Destination role ----

  @requiresDestination
  @requireInitialization
  async getHealthIssues() {
    return this.fetch('/api/v3/health', { schema: z.array(DestinationServerHealthIssue) })
  }

  @requiresDestination
  @requireInitialization
  async registerIndexer(indexerConfig: { name: string, baseUrl: string, apiKey: string, priority: number, categories: number[], downloadClientId?: number }) {
    const existingIndexers = await this.arrGet<any[]>('/api/v3/indexer')
    const existing: any = Array.isArray(existingIndexers)
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
      // Bind grabs from this indexer to jack's own blackhole client (0 = "Any").
      // Without this, *arr may hand a Jack grab to an unrelated download client.
      ...(indexerConfig.downloadClientId ? { downloadClientId: indexerConfig.downloadClientId } : {}),
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
    }
    else {
      await this.fetch('/api/v3/indexer', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        query: { forceSave: 'false' },
      } as any)
    }
  }

  @requiresDestination
  @requireInitialization
  async registerDownloadClient(clientConfig: { name: string, baseUrl: string, username: string, password: string, category: string, priority: number }): Promise<number> {
    const url = new URL(clientConfig.baseUrl)
    const host = url.hostname
    const port = url.port ? Number(url.port) : (url.protocol === 'https:' ? 443 : 80)
    const useSsl = url.protocol === 'https:'
    // urlBase is the path prefix BEFORE /api/v2 (qB's proxy appends /api/v2).
    const urlBase = url.pathname.replace(TRAILING_SLASH_REGEX, '')

    // Match by NAME regardless of implementation so an existing TorrentBlackhole
    // "Jack" client from a previous version is upgraded in place (PUT switches it
    // to QBittorrent/QBittorrentSettings) instead of leaving a duplicate.
    const existingClients = await this.arrGet<any[]>('/api/v3/downloadclient')
    const existing: any = Array.isArray(existingClients)
      ? existingClients.find((client: any) => client.name === clientConfig.name)
      : null

    const body = {
      name: clientConfig.name,
      enable: true,
      protocol: 'torrent',
      priority: clientConfig.priority,
      implementation: 'QBittorrent',
      implementationName: 'qBittorrent',
      configContract: 'QBittorrentSettings',
      fields: [
        { name: 'host', value: host },
        { name: 'port', value: port },
        { name: 'useSsl', value: useSsl },
        { name: 'urlBase', value: urlBase },
        { name: 'username', value: clientConfig.username },
        { name: 'password', value: clientConfig.password },
        { name: this.qbCategoryFieldName, value: clientConfig.category },
      ],
    }

    // forceSave: false keeps *arr's connection test on save — fail loudly rather
    // than register a client *arr can't actually reach/authenticate.
    if (existing) {
      await this.fetch(`/api/v3/downloadclient/${existing.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...body, id: existing.id }),
        query: { forceSave: 'false' },
      } as any)
      return existing.id as number
    }

    const created = await this.fetch<typeof DownloadClientResource>('/api/v3/downloadclient', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      query: { forceSave: 'false' },
      schema: DownloadClientResource,
    } as any)
    return created.id
  }
}
