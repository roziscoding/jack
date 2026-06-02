import type { EpisodeFileResource, EpisodeResource, SeriesResource } from '@jack/schemas/sonarr/types'
import type { AutoRegisterConfig } from '../../config'
import type { Release } from '../../release'
import { ReleaseCategory } from '../../release'
import { ArrServerConnector, basename, stripExtension } from './base'

type SeriesWithId = SeriesResource & { id: number }

export class SonarrServerConnector extends ArrServerConnector {
  constructor(config: { url: string, apiKey: string, name: string, source: boolean, destination: boolean, autoregister: AutoRegisterConfig }) {
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

  protected override get importCommandName(): string {
    return 'DownloadedEpisodeImport'
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

  private async releasesForSeries(series: SeriesWithId, filter?: (e: EpisodeResource) => boolean): Promise<Release[]> {
    const episodes = await this.listEpisodes(series.id)
    return episodes
      .filter(e => e.hasFile && (!filter || filter(e)))
      .map(e => this.buildRelease(e, series, e.episodeFile))
      .filter((r): r is Release => r != null)
  }

  protected override async doSearchItems(term: string): Promise<Release[]> {
    const needle = term.trim().toLowerCase()
    const series = await this.listSeries()
    const matching = series.filter(s => !needle || (s.title ?? '').toLowerCase().includes(needle))
    const perSeries = await Promise.all(matching.map(s => this.releasesForSeries(s)))
    return perSeries.flat()
  }

  protected override async doSearchByImdbId(): Promise<Release[]> {
    // imdb searches map to movies; Sonarr is queried by tvdb instead.
    return []
  }

  protected override async doSearchByTvdbId(tvdbId: string, season?: number, episode?: number): Promise<Release[]> {
    const series = await this.listSeries({ tvdbId })
    const perSeries = await Promise.all(series.map(s => this.releasesForSeries(s, (e) => {
      if (season != null && e.seasonNumber !== season)
        return false
      if (episode != null && e.episodeNumber !== episode)
        return false
      return true
    })))
    return perSeries.flat()
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
}
