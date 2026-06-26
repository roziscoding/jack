import type { AutoRegisterConfig, ConnectorHeadersConfig, ServerConfig } from '../../config'
import type { Release } from '../../release'
import z from 'zod'
import { logger } from '../../../logger'
import { requiresDestination, requiresSource } from '../../decorators/requires-capability'
import { requiresInitialization } from '../../decorators/requires-initialization'
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

// Register the Jack client at *arr's lowest selectable priority (the UI caps it
// at 50). *arr's general client pool only round-robins among the best-priority
// group, so a worst-priority Jack client is never picked for real torrents from
// other indexers — while grabs from the Jack indexer still reach it, because the
// indexer→client binding is resolved before *arr applies the priority grouping.
const JACK_DOWNLOAD_CLIENT_PRIORITY = 50

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
    // `headers` optional so subclasses/tests can omit it; the base defaults it to {}.
    config: Omit<ServerConfig, 'headers'> & { headers?: ConnectorHeadersConfig },
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
  @requiresInitialization
  async searchItems(term: string): Promise<Release[]> {
    return this.doSearchItems(term)
  }

  @requiresSource
  @requiresInitialization
  async searchByImdbId(imdbId: string): Promise<Release[]> {
    return this.doSearchByImdbId(imdbId)
  }

  @requiresSource
  @requiresInitialization
  async searchByTmdbId(tmdbId: string): Promise<Release[]> {
    return this.doSearchByTmdbId(tmdbId)
  }

  @requiresSource
  @requiresInitialization
  async searchByTvdbId(tvdbId: string, season?: number, episode?: number): Promise<Release[]> {
    return this.doSearchByTvdbId(tvdbId, season, episode)
  }

  /** All releases this source can serve — used for the torznab RSS/catalog feed. */
  @requiresSource
  @requiresInitialization
  async listReleases(): Promise<Release[]> {
    return this.doListReleases()
  }

  @requiresSource
  @requiresInitialization
  async getRelease(id: string): Promise<Release | null> {
    return this.doGetRelease(id)
  }

  @requiresSource
  @requiresInitialization
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
  @requiresInitialization
  async getHealthIssues() {
    return this.fetch('/api/v3/health', { schema: z.array(DestinationServerHealthIssue) })
  }

  @requiresDestination
  @requiresInitialization
  async getQualityProfiles(): Promise<Array<{ id: number, name: string }>> {
    const profiles = await this.arrGet<Array<{ id: number, name: string }>>('/api/v3/qualityprofile')
    return (Array.isArray(profiles) ? profiles : [])
      .filter(p => p.id != null && p.name != null)
      .map(p => ({ id: p.id, name: p.name }))
  }

  @requiresDestination
  @requiresInitialization
  async getRootFolders(): Promise<Array<{ path: string, freeSpace?: number }>> {
    const folders = await this.arrGet<Array<{ path: string, freeSpace?: number }>>('/api/v3/rootfolder')
    return (Array.isArray(folders) ? folders : [])
      .filter(f => typeof f.path === 'string')
      .map(f => ({ path: f.path, freeSpace: f.freeSpace }))
  }

  /**
   * Lowercased torrent infohashes (`downloadId`s) that this *arr has finished
   * importing recently, read from its history. The import watcher matches these
   * against `import_queued` downloads to flip them to `imported`. Lowercased on
   * both sides because *arr may store the infohash in a different case than jack
   * derives it.
   */
  @requiresDestination
  @requiresInitialization
  async recentlyImportedDownloadIds(limit = 200): Promise<Set<string>> {
    const res = await this.arrGet<{ records?: Array<{ downloadId?: string | null, eventType?: string | null }> }>(
      '/api/v3/history',
      { page: '1', pageSize: String(limit), sortKey: 'date', sortDirection: 'descending' },
    )
    const ids = new Set<string>()
    for (const record of res?.records ?? []) {
      if (record.eventType === 'downloadFolderImported' && record.downloadId)
        ids.add(record.downloadId.toLowerCase())
    }
    return ids
  }

  @requiresDestination
  @requiresInitialization
  async registerIndexer(indexerConfig: { name: string, internalUrl: string, apiKey: string, priority: number, categories: number[], downloadClientId?: number }) {
    const existingIndexers = await this.arrGet<any[]>('/api/v3/indexer')
    const existing: any = Array.isArray(existingIndexers)
      ? existingIndexers.find((idx: any) =>
          idx.fields?.some((f: any) => f.name === 'baseUrl' && f.value === indexerConfig.internalUrl))
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
        { name: 'baseUrl', value: indexerConfig.internalUrl },
        { name: 'apiPath', value: '/api' },
        { name: 'apiKey', value: indexerConfig.apiKey },
        { name: 'categories', value: indexerConfig.categories },
        { name: 'minimumSeeders', value: 0 },
      ],
    }

    // forceSave: true registers the indexer even when *arr's test query returns
    // no results (e.g. no peers / empty catalog yet). We always want the Jack
    // indexer present and bound to the Jack client; it starts returning results
    // as soon as peers come online.
    if (existing) {
      await this.fetch(`/api/v3/indexer/${existing.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...body, id: existing.id }),
        query: { forceSave: 'true' },
      } as any)
    }
    else {
      await this.fetch('/api/v3/indexer', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        query: { forceSave: 'true' },
      } as any)
    }
  }

  @requiresDestination
  @requiresInitialization
  public async registerDownloadClient(clientConfig: { name: string, internalUrl: string, username: string, password: string, category: string }): Promise<number> {
    const url = new URL(clientConfig.internalUrl)
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
      priority: JACK_DOWNLOAD_CLIENT_PRIORITY,
      implementation: 'QBittorrent',
      implementationName: 'qBittorrent',
      configContract: 'QBittorrentSettings',
      // Explicitly clear tags: an earlier version tagged this client, which broke
      // grabs (*arr filters the indexer-bound client by movie tags too).
      tags: [],
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

    // forceSave: true registers the client even if *arr's connection test can't
    // reach jack at registration time. This guarantees the client is saved and
    // its id returned, so the indexer can always be bound to it (an unbound
    // indexer is the failure mode when the test throws here).
    if (existing) {
      await this.fetch(`/api/v3/downloadclient/${existing.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...body, id: existing.id }),
        query: { forceSave: 'true' },
      } as any)
      return existing.id as number
    }

    const created = await this.fetch<typeof DownloadClientResource>('/api/v3/downloadclient', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      query: { forceSave: 'true' },
      schema: DownloadClientResource,
    } as any)
    return created.id
  }
}
