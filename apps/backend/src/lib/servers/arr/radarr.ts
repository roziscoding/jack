import type { MovieFileResource, MovieResource } from '@jack/schemas/radarr/types'
import type { AutoRegisterConfig } from '../../config'
import type { Release } from '../../release'
import { normalizeImdbId, ReleaseCategory } from '../../release'
import { withSpan } from '../../tracing'
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
    return withSpan('radarr.search_items', {
      'source.name': this.name,
      'search.term': term,
    }, async (span) => {
      const needle = term.trim().toLowerCase()
      const movies = await this.listMovies()
      const withFile = movies.filter(m => m.hasFile).length
      const releases = movies
        .filter(m => m.hasFile && (!needle || (m.title ?? '').toLowerCase().includes(needle)))
        .map(m => this.toRelease(m))
        .filter((r): r is Release => r != null)
      span.setAttributes({ 'movie.count': movies.length, 'movie.with_file_count': withFile, 'release.count': releases.length })
      return releases
    })
  }

  protected override async doSearchByImdbId(imdbId: string): Promise<Release[]> {
    // Compare without the `tt` prefix: *arr stores `tt0133093`, torznab clients
    // (Radarr) query `imdbid=0133093`. Without this, the search never matches.
    return withSpan('radarr.search_by_imdb', {
      'source.name': this.name,
      'search.imdb_id': imdbId,
    }, async (span) => {
      const target = normalizeImdbId(imdbId)
      const movies = await this.listMovies()
      const withFileMovies = movies.filter(m => m.hasFile)
      const releases = withFileMovies
        .filter(m => m.imdbId != null && normalizeImdbId(m.imdbId) === target)
        .map(m => this.toRelease(m))
        .filter((r): r is Release => r != null)
      span.setAttributes({ 'movie.count': movies.length, 'movie.with_file_count': withFileMovies.length, 'release.count': releases.length })
      if (releases.length === 0) {
        span.setAttribute('search.sample_imdb_ids', withFileMovies.map(m => m.imdbId).filter((id): id is string => !!id).slice(0, 10))
      }
      return releases
    })
  }

  protected override async doSearchByTmdbId(tmdbId: string): Promise<Release[]> {
    // Radarr filters /movie by tmdbId server-side, so this is a targeted lookup
    // (one movie) instead of listing the whole library.
    return withSpan('radarr.search_by_tmdb', {
      'source.name': this.name,
      'search.tmdb_id': tmdbId,
    }, async (span) => {
      const movies = await this.arrGet<MovieResource[]>('/api/v3/movie', { tmdbId })
      const releases = (Array.isArray(movies) ? movies : [])
        .filter(m => m.hasFile)
        .map(m => this.toRelease(m))
        .filter((r): r is Release => r != null)
      span.setAttribute('release.count', releases.length)
      return releases
    })
  }

  protected override async doSearchByTvdbId(): Promise<Release[]> {
    // Radarr only tracks movies; tvdb searches never match here.
    return []
  }

  protected override async doListReleases(): Promise<Release[]> {
    const movies = await this.listMovies()
    return movies
      .filter(m => m.hasFile)
      .map(m => this.toRelease(m))
      .filter((r): r is Release => r != null)
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
