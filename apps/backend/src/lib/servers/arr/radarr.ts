import type { MovieFileResource, MovieResource } from '@jack/schemas/radarr/types'
import type { AutoRegisterConfig, ConnectorHeadersConfig } from '../../config'
import type { Release } from '../../release'
import type { AddParams, ManualImportParams, ManualImportTarget } from './base'
import { z } from 'zod'
import { BadRequestError } from '../../errors/BadRequestError'
import { normalizeImdbId, ReleaseCategory } from '../../release'
import { setSpanAttribute, setSpanAttributes } from '../../span-attributes'
import { withSpan } from '../../tracing'
import { ArrServerConnector, basename, stripExtension } from './base'

const CreatedId = z.object({ id: z.number().int() })

interface ManualImportCandidate {
  path?: string
  quality?: unknown
  languages?: unknown[]
  releaseGroup?: string
}

export class RadarrServerConnector extends ArrServerConnector {
  constructor(config: { url: string, apiKey: string, name: string, source: boolean, destination: boolean, autoregister: AutoRegisterConfig, headers?: ConnectorHeadersConfig }) {
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

  protected override get qbCategoryFieldName(): string {
    return 'movieCategory'
  }

  protected override get internalIndexerFlagValue(): number {
    return 32
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
      setSpanAttributes(span, { 'movie.count': movies.length, 'movie.with_file_count': withFile, 'release.count': releases.length })
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
      setSpanAttributes(span, { 'movie.count': movies.length, 'movie.with_file_count': withFileMovies.length, 'release.count': releases.length })
      if (releases.length === 0) {
        setSpanAttribute(span, 'search.sample_imdb_ids', withFileMovies.map(m => m.imdbId).filter((id): id is string => !!id).slice(0, 10))
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
      setSpanAttribute(span, 'release.count', releases.length)
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

  protected override async importedReleasesFor(target: ManualImportTarget): Promise<Release[]> {
    if (target.kind !== 'movie')
      return []
    // toRelease returns null unless the movie has a file, so this is empty until
    // Radarr has actually imported something for the movie.
    const movie = await this.arrGet<MovieResource>(`/api/v3/movie/${target.movieId}`)
    const release = movie ? this.toRelease(movie) : null
    return release ? [release] : []
  }

  protected override async doAdd(params: AddParams): Promise<number> {
    if (params.tmdbId == null)
      throw new BadRequestError('A tmdbId is required to add a movie to Radarr')

    // Idempotent: reuse the movie if it's already in the library.
    const existing = await this.arrGet<MovieResource[]>('/api/v3/movie', { tmdbId: String(params.tmdbId) })
    const found = Array.isArray(existing) ? existing.find(m => m.id != null) : undefined
    if (found?.id != null)
      return found.id

    const lookup = await this.arrGet<MovieResource[]>('/api/v3/movie/lookup', { term: `tmdb:${params.tmdbId}` })
    const movie = Array.isArray(lookup) ? lookup[0] : undefined
    if (!movie)
      throw new BadRequestError(`No movie found on ${this.name} for tmdbId ${params.tmdbId}`)

    const body = {
      ...movie,
      qualityProfileId: await this.resolveQualityProfileId(),
      rootFolderPath: params.rootFolderPath,
      monitored: true,
      minimumAvailability: 'released',
      addOptions: { searchForMovie: false },
    }
    const created = await this.fetch('/api/v3/movie', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      schema: CreatedId,
    })
    return created.id
  }

  protected override async doManualImport(params: ManualImportParams): Promise<number> {
    if (params.target.kind !== 'movie')
      throw new BadRequestError(`Radarr cannot import a "${params.target.kind}" target`)
    const { movieId } = params.target

    const candidates = await this.arrGet<ManualImportCandidate[]>('/api/v3/manualimport', {
      folder: params.folder,
      movieId: String(movieId),
      filterExistingFiles: 'false',
    })
    const wanted = new Set(params.paths)
    const files = (Array.isArray(candidates) ? candidates : [])
      .filter((c): c is ManualImportCandidate & { path: string } => typeof c.path === 'string' && wanted.has(c.path))
      .map(c => ({
        path: c.path,
        movieId,
        quality: c.quality,
        languages: c.languages ?? [],
        releaseGroup: c.releaseGroup ?? '',
        downloadId: params.downloadId,
      }))
    if (files.length === 0)
      throw new BadRequestError(`Radarr found no importable file for movie ${movieId} in ${params.folder}`)

    const command = await this.fetch('/api/v3/command', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'ManualImport', importMode: 'move', files }),
      schema: CreatedId,
    })
    return command.id
  }
}
