import type { MovieFileResource, MovieResource } from '@jack/schemas/radarr/types'
import type { AutoRegisterConfig } from '../../config'
import type { Release } from '../../release'
import { logger } from '../../../logger'
import { ReleaseCategory } from '../../release'
import { ArrServerConnector, basename, stripExtension } from './base'

export class RadarrServerConnector extends ArrServerConnector {
  constructor(config: { url: string, apiKey: string, name: string, source: boolean, destination: boolean, autoregister: AutoRegisterConfig }) {
    super({
      pingPath: '/api/v3/system/status',
      pingMethod: 'GET',
      authHeader: 'X-Api-Key',
      expectedAppName: 'Radarr',
    }, { ...config, type: 'radarr' })
  }

  override get categories(): number[] {
    return [ReleaseCategory.Movie]
  }

  protected override get importCommandName(): string {
    return 'DownloadedMoviesScan'
  }

  private toRelease(movie: MovieResource): Release | null {
    const file = movie.movieFile
    if (!movie.id || !movie.hasFile || !file)
      return null

    const path = file.path ?? file.relativePath ?? null
    const title = file.sceneName ?? (path ? stripExtension(basename(path)) : movie.title ?? 'Unknown')
    const filename = path ? basename(path) : title

    return {
      id: this.buildId('movie', movie.id),
      title,
      filename,
      category: ReleaseCategory.Movie,
      size: file.size ?? movie.sizeOnDisk ?? 0,
      imdbId: movie.imdbId ?? undefined,
      tmdbId: movie.tmdbId ?? undefined,
      quality: file.quality?.quality
        ? {
            name: file.quality.quality.name ?? undefined,
            source: file.quality.quality.source ?? undefined,
            resolution: file.quality.quality.resolution ?? undefined,
          }
        : undefined,
      languages: file.languages?.map(l => l.name).filter((n): n is string => !!n),
      releaseGroup: file.releaseGroup ?? undefined,
      edition: file.edition ?? undefined,
      mediaInfo: (file.mediaInfo as Record<string, unknown> | undefined) ?? undefined,
      publishDate: file.dateAdded ?? undefined,
    }
  }

  private async listMovies(): Promise<MovieResource[]> {
    const movies = await this.arrGet<MovieResource[]>('/api/v3/movie')
    return Array.isArray(movies) ? movies : []
  }

  protected override async doSearchItems(term: string): Promise<Release[]> {
    const needle = term.trim().toLowerCase()
    const movies = await this.listMovies()
    const releases = movies
      .filter(m => m.hasFile && (!needle || (m.title ?? '').toLowerCase().includes(needle)))
      .map(m => this.toRelease(m))
      .filter((r): r is Release => r != null)
    logger.debug({ source: this.name, term, totalMovies: movies.length, withFile: movies.filter(m => m.hasFile).length, matched: releases.length }, 'Radarr term search')
    return releases
  }

  protected override async doSearchByImdbId(imdbId: string): Promise<Release[]> {
    const movies = await this.listMovies()
    const releases = movies
      .filter(m => m.hasFile && m.imdbId === imdbId)
      .map(m => this.toRelease(m))
      .filter((r): r is Release => r != null)
    logger.debug({ source: this.name, imdbId, totalMovies: movies.length, withFile: movies.filter(m => m.hasFile).length, matched: releases.length }, 'Radarr imdb search')
    if (releases.length === 0)
      logger.trace({ source: this.name, imdbId, sampleImdbIds: movies.filter(m => m.hasFile).map(m => m.imdbId).slice(0, 10) }, 'Radarr imdb search found nothing — sample of available imdbIds')
    return releases
  }

  protected override async doSearchByTvdbId(): Promise<Release[]> {
    // Radarr only tracks movies; tvdb searches never match here.
    return []
  }

  private async getMovie(id: string): Promise<MovieResource | null> {
    const parsed = this.parseId(id)
    if (!parsed || parsed.kind !== 'movie')
      return null
    return this.arrGet<MovieResource>(`/api/v3/movie/${parsed.entityId}`)
  }

  protected override async doGetRelease(id: string): Promise<Release | null> {
    const movie = await this.getMovie(id)
    return movie ? this.toRelease(movie) : null
  }

  protected override async doGetFilePath(id: string): Promise<string | null> {
    const movie = await this.getMovie(id)
    return (movie?.movieFile as MovieFileResource | undefined)?.path ?? null
  }
}
