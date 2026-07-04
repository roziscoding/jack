import type { EpisodeFileResource, EpisodeResource, SeriesResource } from '@jack/schemas/sonarr/types'
import type { AutoRegisterConfig, ConnectorHeadersConfig } from '../../config'
import type { Release } from '../../release'
import type { AddParams, ManualImportParams, ManualImportTarget } from './base'
import { z } from 'zod'
import { BadRequestError } from '../../errors/BadRequestError'
import { ReleaseCategory } from '../../release'
import { setSpanAttributes } from '../../span-attributes'
import { withSpan } from '../../tracing'
import { ArrServerConnector, basename, PermanentManualImportError, stripExtension } from './base'

type SeriesWithId = SeriesResource & { id: number }

const CreatedId = z.object({ id: z.number().int() })

interface SonarrManualImportCandidate {
  path?: string
  quality?: unknown
  languages?: unknown[]
  releaseGroup?: string
  episodes?: Array<{ id?: number }>
}

export class SonarrServerConnector extends ArrServerConnector {
  constructor(config: { url: string, apiKey: string, name: string, source: boolean, destination: boolean, autoregister: AutoRegisterConfig, headers?: ConnectorHeadersConfig }) {
    super({
      pingPath: '/api/v3/system/status',
      pingMethod: 'GET',
      authHeader: 'X-Api-Key',
      expectedAppName: 'Sonarr',
    }, { ...config, type: 'sonarr' })
  }

  override get categories(): number[] {
    return [ReleaseCategory.Tv]
  }

  protected override get qbCategoryFieldName(): string {
    return 'tvCategory'
  }

  protected override get internalIndexerFlagValue(): number {
    return 8
  }

  private buildRelease(episode: EpisodeResource, series: SeriesResource | undefined, file: EpisodeFileResource | undefined): Release | null {
    if (!episode.id || !episode.hasFile || !file)
      return null

    const path = file.path ?? file.relativePath ?? null
    const title = file.sceneName ?? (path ? stripExtension(basename(path)) : (series?.title ?? episode.title ?? 'Unknown'))
    const filename = path ? basename(path) : title

    return {
      id: this.buildId('episode', episode.id),
      title,
      filename,
      category: ReleaseCategory.Tv,
      size: file.size ?? 0,
      imdbId: series?.imdbId ?? undefined,
      tmdbId: series?.tmdbId ?? undefined,
      tvdbId: series?.tvdbId ?? undefined,
      quality: file.quality?.quality
        ? {
            name: file.quality.quality.name ?? undefined,
            source: file.quality.quality.source ?? undefined,
            resolution: file.quality.quality.resolution ?? undefined,
          }
        : undefined,
      languages: file.languages?.map(l => l.name).filter((n): n is string => !!n),
      releaseGroup: file.releaseGroup ?? undefined,
      mediaInfo: (file.mediaInfo as Record<string, unknown> | undefined) ?? undefined,
      seriesTitle: series?.title ?? undefined,
      season: episode.seasonNumber ?? undefined,
      episode: episode.episodeNumber ?? undefined,
      publishDate: file.dateAdded ?? undefined,
    }
  }

  private async listSeries(query?: Record<string, string>): Promise<SeriesWithId[]> {
    const series = await this.arrGet<SeriesResource[]>('/api/v3/series', query)
    return (Array.isArray(series) ? series : []).filter((s): s is SeriesWithId => s.id != null)
  }

  private async listEpisodes(seriesId: number): Promise<EpisodeResource[]> {
    const episodes = await this.arrGet<EpisodeResource[]>('/api/v3/episode', {
      seriesId: String(seriesId),
      includeEpisodeFile: 'true',
    })
    return Array.isArray(episodes) ? episodes : []
  }

  private async episodeIdsFromRelease(seriesId: number, release: ManualImportParams['release']): Promise<number[]> {
    if (release?.season == null || release.episode == null)
      return []
    const episodes = await this.listEpisodes(seriesId)
    return episodes
      .filter(e => e.seasonNumber === release.season && e.episodeNumber === release.episode)
      .map(e => e.id)
      .filter((id): id is number => id != null)
  }

  private async releasesForSeries(series: SeriesWithId, filter?: (e: EpisodeResource) => boolean): Promise<Release[]> {
    const episodes = await this.listEpisodes(series.id)
    return episodes
      .filter(e => e.hasFile && (!filter || filter(e)))
      .map(e => this.buildRelease(e, series, e.episodeFile))
      .filter((r): r is Release => r != null)
  }

  protected override async doSearchItems(term: string): Promise<Release[]> {
    return withSpan('sonarr.search_items', {
      'source.name': this.name,
      'search.term': term,
    }, async (span) => {
      const needle = term.trim().toLowerCase()
      const series = await this.listSeries()
      const matching = series.filter(s => !needle || (s.title ?? '').toLowerCase().includes(needle))
      const perSeries = await Promise.all(matching.map(s => this.releasesForSeries(s)))
      const releases = perSeries.flat()
      setSpanAttributes(span, { 'series.count': series.length, 'series.matched_count': matching.length, 'release.count': releases.length })
      return releases
    })
  }

  protected override async doSearchByImdbId(): Promise<Release[]> {
    // imdb searches map to movies; Sonarr is queried by tvdb instead.
    return []
  }

  protected override async doSearchByTmdbId(): Promise<Release[]> {
    // tmdb (movie) searches map to Radarr; Sonarr is queried by tvdb.
    return []
  }

  protected override async doListReleases(): Promise<Release[]> {
    const series = await this.listSeries()
    const perSeries = await Promise.all(series.map(s => this.releasesForSeries(s)))
    return perSeries.flat()
  }

  protected override async doSearchByTvdbId(tvdbId: string, season?: number, episode?: number): Promise<Release[]> {
    return withSpan('sonarr.search_by_tvdb', {
      'source.name': this.name,
      'search.tvdb_id': tvdbId,
      'search.season': season,
      'search.episode': episode,
    }, async (span) => {
      const series = await this.listSeries({ tvdbId })
      const perSeries = await Promise.all(series.map(s => this.releasesForSeries(s, (e) => {
        if (season != null && e.seasonNumber !== season)
          return false
        if (episode != null && e.episodeNumber !== episode)
          return false
        return true
      })))
      const releases = perSeries.flat()
      setSpanAttributes(span, { 'series.matched_count': series.length, 'release.count': releases.length })
      return releases
    })
  }

  private async fetchEpisodeBundle(id: string): Promise<{ episode: EpisodeResource, series?: SeriesResource, file?: EpisodeFileResource } | null> {
    const parsed = this.parseId(id)
    if (!parsed || parsed.kind !== 'episode')
      return null

    const episode = await this.arrGet<EpisodeResource>(`/api/v3/episode/${parsed.entityId}`)
    if (!episode?.id)
      return null

    const [series, file] = await Promise.all([
      episode.seriesId != null
        ? this.arrGet<SeriesResource>(`/api/v3/series/${episode.seriesId}`).catch(() => undefined)
        : Promise.resolve(undefined),
      episode.episodeFileId
        ? this.arrGet<EpisodeFileResource>(`/api/v3/episodefile/${episode.episodeFileId}`).catch(() => undefined)
        : Promise.resolve(undefined),
    ])

    return { episode, series, file }
  }

  protected override async doGetRelease(id: string): Promise<Release | null> {
    const bundle = await this.fetchEpisodeBundle(id)
    return bundle ? this.buildRelease(bundle.episode, bundle.series, bundle.file) : null
  }

  protected override async doGetFilePath(id: string): Promise<string | null> {
    const bundle = await this.fetchEpisodeBundle(id)
    return bundle?.file?.path ?? null
  }

  protected override async importedReleasesFor(target: ManualImportTarget): Promise<Release[]> {
    if (target.kind !== 'series')
      return []
    // Every on-disk episode file for the series; the caller's size/title match
    // picks out the one that corresponds to the queued release.
    const series = await this.arrGet<SeriesResource>(`/api/v3/series/${target.seriesId}`).catch(() => undefined)
    const seriesWithId = series?.id != null ? (series as SeriesWithId) : undefined
    return this.releasesForSeries(
      seriesWithId ?? ({ id: target.seriesId } as SeriesWithId),
    )
  }

  protected override async doAdd(params: AddParams): Promise<number> {
    if (params.tvdbId == null)
      throw new BadRequestError('A tvdbId is required to add a series to Sonarr')

    const existing = await this.listSeries({ tvdbId: String(params.tvdbId) })
    if (existing[0]?.id != null)
      return existing[0].id

    const lookup = await this.arrGet<SeriesResource[]>('/api/v3/series/lookup', { term: `tvdb:${params.tvdbId}` })
    const series = Array.isArray(lookup) ? lookup[0] : undefined
    if (!series)
      throw new BadRequestError(`No series found on ${this.name} for tvdbId ${params.tvdbId}`)

    const body = {
      ...series,
      qualityProfileId: await this.resolveQualityProfileId(),
      rootFolderPath: params.rootFolderPath,
      monitored: true,
      seasonFolder: true,
      addOptions: { monitor: 'all', searchForMissingEpisodes: false },
    }
    const created = await this.fetch('/api/v3/series', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      schema: CreatedId,
    })
    return created.id
  }

  protected override async doManualImport(params: ManualImportParams): Promise<number> {
    if (params.target.kind !== 'series')
      throw new BadRequestError(`Sonarr cannot import a "${params.target.kind}" target`)
    const { seriesId } = params.target

    const candidates = await this.arrGet<SonarrManualImportCandidate[]>('/api/v3/manualimport', {
      folder: params.folder,
      seriesId: String(seriesId),
      filterExistingFiles: 'false',
    })
    const wanted = new Set(params.paths)
    const matches = (Array.isArray(candidates) ? candidates : [])
      .filter((c): c is SonarrManualImportCandidate & { path: string } => typeof c.path === 'string' && wanted.has(c.path))
    if (matches.length === 0)
      throw new BadRequestError(`Sonarr found no importable episode file for series ${seriesId} in ${params.folder}`)

    const fallbackEpisodeIds = await this.episodeIdsFromRelease(seriesId, params.release)
    const files = matches.map((c) => {
      const parsedEpisodeIds = (c.episodes ?? []).map(e => e.id).filter((id): id is number => id != null)
      const episodeIds = parsedEpisodeIds.length > 0 ? parsedEpisodeIds : fallbackEpisodeIds
      if (episodeIds.length === 0)
        throw new PermanentManualImportError(`Sonarr could not resolve episode ids for ${c.path}`)
      return {
        path: c.path,
        seriesId,
        episodeIds,
        quality: c.quality,
        languages: c.languages ?? [],
        releaseGroup: c.releaseGroup ?? '',
        downloadId: params.downloadId,
      }
    })

    const command = await this.fetch('/api/v3/command', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'ManualImport', importMode: 'move', files }),
      schema: CreatedId,
    })
    return command.id
  }
}
