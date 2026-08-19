import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { http, HttpResponse } from 'msw'
import { setupServer } from 'msw/node'
import { z } from 'zod'
import { BadRequestError } from '../../errors/BadRequestError'
import { RadarrServerConnector } from './radarr'
import { SonarrServerConnector } from './sonarr'

const RADARR_URL = 'http://radarr.test:7878'
const SONARR_URL = 'http://sonarr.test:8989'
const HEX_KEY = 'a'.repeat(32)
const AUTOREGISTER = { enable: true, priority: 1 }

// Default handlers shared by every test: identity ping (drives the
// @requiresInitialization guard's auto-init) + a single quality profile.
const handlers = [
  http.get(`${RADARR_URL}/api/v3/system/status`, () => HttpResponse.json({ appName: 'Radarr', version: '4.0.0' })),
  http.get(`${SONARR_URL}/api/v3/system/status`, () => HttpResponse.json({ appName: 'Sonarr', version: '4.0.0' })),
  http.get(`${RADARR_URL}/api/v3/qualityprofile`, () => HttpResponse.json([{ id: 4 }])),
  http.get(`${SONARR_URL}/api/v3/qualityprofile`, () => HttpResponse.json([{ id: 7 }])),
]

const server = setupServer(...handlers)

beforeAll(() => server.listen({ onUnhandledRequest: 'bypass' }))
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

function makeRadarr() {
  return new RadarrServerConnector({
    url: RADARR_URL,
    apiKey: HEX_KEY,
    name: 'My Radarr',
    source: true,
    destination: true,
    autoregister: AUTOREGISTER,
  })
}

function makeSonarr() {
  return new SonarrServerConnector({
    url: SONARR_URL,
    apiKey: HEX_KEY,
    name: 'My Sonarr',
    source: true,
    destination: true,
    autoregister: AUTOREGISTER,
  })
}

// The candidate `quality`/`languages` are opaque blobs we forward verbatim, so a
// schema is the rule-compliant way to read the captured POST body back as typed.
const CommandBody = z.object({
  name: z.string(),
  importMode: z.string(),
  files: z.array(z.object({
    path: z.string(),
    movieId: z.number().optional(),
    seriesId: z.number().optional(),
    episodeIds: z.array(z.number()).optional(),
    downloadId: z.string(),
    quality: z.unknown(),
    languages: z.array(z.unknown()),
    releaseGroup: z.string().optional(),
  })),
})

const lookedUpMovie = { tmdbId: 603, title: 'The Matrix', year: 1999, titleSlug: 'the-matrix-603', images: [] }
const lookedUpSeries = { tvdbId: 81189, title: 'Breaking Bad', year: 2008, titleSlug: 'breaking-bad-81189', images: [] }

describe('RadarrServerConnector.add', () => {
  test('looks up the movie and POSTs it WITHOUT a search, returning the created id', async () => {
    let postBody: unknown = null
    let lookupTerm: string | null = null
    server.use(
      http.get(`${RADARR_URL}/api/v3/movie`, () => HttpResponse.json([])),
      http.get(`${RADARR_URL}/api/v3/movie/lookup`, ({ request }) => {
        lookupTerm = new URL(request.url).searchParams.get('term')
        return HttpResponse.json([lookedUpMovie])
      }),
      http.post(`${RADARR_URL}/api/v3/movie`, async ({ request }) => {
        postBody = await request.json()
        return HttpResponse.json({ id: 1, ...lookedUpMovie })
      }),
    )

    const radarr = makeRadarr()
    const id = await radarr.add({ tmdbId: 603, rootFolderPath: '/movies' })

    expect(id).toBe(1)
    expect<string | null>(lookupTerm).toBe('tmdb:603')
    expect(postBody).toMatchObject({
      tmdbId: 603,
      title: 'The Matrix',
      qualityProfileId: 4,
      rootFolderPath: '/movies',
      monitored: true,
      addOptions: { searchForMovie: false },
    })
  })

  test('is idempotent: returns the existing movie id without POSTing when already in the library', async () => {
    let posted = false
    server.use(
      http.get(`${RADARR_URL}/api/v3/movie`, () => HttpResponse.json([{ id: 99 }])),
      http.post(`${RADARR_URL}/api/v3/movie`, () => {
        posted = true
        return HttpResponse.json({ id: 99 })
      }),
    )

    const radarr = makeRadarr()
    const id = await radarr.add({ tmdbId: 603, rootFolderPath: '/movies' })

    expect(id).toBe(99)
    expect(posted).toBe(false)
  })

  test('throws BadRequestError when no tmdbId is given', async () => {
    const radarr = makeRadarr()
    await expect(radarr.add({ rootFolderPath: '/movies' })).rejects.toThrow(BadRequestError)
  })

  test('throws BadRequestError naming the server and id when the lookup is empty', async () => {
    server.use(
      http.get(`${RADARR_URL}/api/v3/movie`, () => HttpResponse.json([])),
      http.get(`${RADARR_URL}/api/v3/movie/lookup`, () => HttpResponse.json([])),
    )
    const radarr = makeRadarr()
    const promise = radarr.add({ tmdbId: 603, rootFolderPath: '/movies' })
    await expect(promise).rejects.toThrow(BadRequestError)
    await expect(promise).rejects.toThrow(/My Radarr/)
    await expect(promise).rejects.toThrow(/603/)
  })
})

describe('RadarrServerConnector.manualImport', () => {
  test('discovers candidates without movieId and imports only the file matching params.paths', async () => {
    let commandBody: unknown = null
    const manualImportUrls: string[] = []
    server.use(
      http.get(`${RADARR_URL}/api/v3/manualimport`, ({ request }) => {
        manualImportUrls.push(request.url)
        return HttpResponse.json([
          { path: '/downloads/Movie.mkv', quality: { quality: { id: 7 } }, languages: [{ id: 1, name: 'English' }], releaseGroup: 'GRP' },
          { path: '/downloads/Other.mkv', quality: { quality: { id: 3 } }, languages: [{ id: 2, name: 'French' }], releaseGroup: 'X' },
        ])
      }),
      http.post(`${RADARR_URL}/api/v3/command`, async ({ request }) => {
        commandBody = await request.json()
        return HttpResponse.json({ id: 1 })
      }),
    )

    const radarr = makeRadarr()
    const commandId = await radarr.manualImport({
      folder: '/downloads',
      paths: ['/downloads/Movie.mkv'],
      target: { kind: 'movie', movieId: 7 },
      downloadId: 'dl-1',
    })

    const body = CommandBody.parse(commandBody)
    const manualImportQuery = new URL(manualImportUrls[0]!).searchParams
    // Radarr ignores `folder` when movieId is set, scanning the (not yet existing)
    // library folder instead of the download folder.
    expect(manualImportQuery.get('movieId')).toBeNull()
    expect(manualImportQuery.get('folder')).toBe('/downloads')
    expect(manualImportQuery.get('filterExistingFiles')).toBe('false')
    expect(commandId).toBe(1)
    expect(body.name).toBe('ManualImport')
    expect(body.importMode).toBe('move')
    expect(body.files).toHaveLength(1)
    expect(body.files[0]).toMatchObject({
      path: '/downloads/Movie.mkv',
      movieId: 7,
      downloadId: 'dl-1',
      quality: { quality: { id: 7 } },
      languages: [{ id: 1, name: 'English' }],
      releaseGroup: 'GRP',
    })
  })

  test('throws BadRequestError when given a series target', async () => {
    const radarr = makeRadarr()
    await expect(radarr.manualImport({
      folder: '/downloads',
      paths: ['/downloads/Movie.mkv'],
      target: { kind: 'series', seriesId: 1 },
      downloadId: 'dl-1',
    })).rejects.toThrow(BadRequestError)
  })

  test('throws BadRequestError when no candidate matches the wanted path', async () => {
    server.use(
      http.get(`${RADARR_URL}/api/v3/manualimport`, () => HttpResponse.json([
        { path: '/downloads/Other.mkv', quality: {}, languages: [] },
      ])),
    )
    const radarr = makeRadarr()
    await expect(radarr.manualImport({
      folder: '/downloads',
      paths: ['/downloads/Movie.mkv'],
      target: { kind: 'movie', movieId: 7 },
      downloadId: 'dl-1',
    })).rejects.toThrow(BadRequestError)
  })
})

describe('SonarrServerConnector.add', () => {
  test('looks up the series and POSTs it WITHOUT a search, returning the created id', async () => {
    let postBody: unknown = null
    let lookupTerm: string | null = null
    server.use(
      http.get(`${SONARR_URL}/api/v3/series`, () => HttpResponse.json([])),
      http.get(`${SONARR_URL}/api/v3/series/lookup`, ({ request }) => {
        lookupTerm = new URL(request.url).searchParams.get('term')
        return HttpResponse.json([lookedUpSeries])
      }),
      http.post(`${SONARR_URL}/api/v3/series`, async ({ request }) => {
        postBody = await request.json()
        return HttpResponse.json({ id: 1, ...lookedUpSeries })
      }),
    )

    const sonarr = makeSonarr()
    const id = await sonarr.add({ tvdbId: 81189, rootFolderPath: '/tv' })

    expect(id).toBe(1)
    expect<string | null>(lookupTerm).toBe('tvdb:81189')
    expect(postBody).toMatchObject({
      tvdbId: 81189,
      title: 'Breaking Bad',
      qualityProfileId: 7,
      rootFolderPath: '/tv',
      monitored: true,
      seasonFolder: true,
      addOptions: { monitor: 'all', searchForMissingEpisodes: false },
    })
  })

  test('is idempotent: returns the existing series id without POSTing when already in the library', async () => {
    let posted = false
    server.use(
      http.get(`${SONARR_URL}/api/v3/series`, () => HttpResponse.json([{ id: 42 }])),
      http.post(`${SONARR_URL}/api/v3/series`, () => {
        posted = true
        return HttpResponse.json({ id: 42 })
      }),
    )

    const sonarr = makeSonarr()
    const id = await sonarr.add({ tvdbId: 81189, rootFolderPath: '/tv' })

    expect(id).toBe(42)
    expect(posted).toBe(false)
  })

  test('throws BadRequestError when no tvdbId is given', async () => {
    const sonarr = makeSonarr()
    await expect(sonarr.add({ rootFolderPath: '/tv' })).rejects.toThrow(BadRequestError)
  })
})

describe('SonarrServerConnector.manualImport', () => {
  test('discovers candidates without seriesId and imports the match with explicit series metadata', async () => {
    let commandBody: unknown = null
    const manualImportUrls: string[] = []
    server.use(
      http.get(`${SONARR_URL}/api/v3/manualimport`, ({ request }) => {
        manualImportUrls.push(request.url)
        return HttpResponse.json([
          { path: '/downloads/Ep.mkv', quality: { quality: { id: 4 } }, languages: [{ id: 1, name: 'English' }], releaseGroup: 'GRP', episodes: [{ id: 11 }, { id: 12 }] },
          { path: '/downloads/Other.mkv', quality: {}, languages: [], episodes: [{ id: 99 }] },
        ])
      }),
      http.post(`${SONARR_URL}/api/v3/command`, async ({ request }) => {
        commandBody = await request.json()
        return HttpResponse.json({ id: 1 })
      }),
    )

    const sonarr = makeSonarr()

    const commandId = await sonarr.manualImport({
      folder: '/downloads',
      paths: ['/downloads/Ep.mkv'],
      target: { kind: 'series', seriesId: 3 },
      downloadId: 'dl-2',
    })

    const body = CommandBody.parse(commandBody)
    const manualImportQuery = new URL(manualImportUrls[0]!).searchParams
    expect(manualImportQuery.get('folder')).toBe('/downloads')
    expect(manualImportQuery.get('filterExistingFiles')).toBe('false')
    expect(manualImportQuery.has('seriesId')).toBe(false)
    expect(commandId).toBe(1)
    expect(body.name).toBe('ManualImport')
    expect(body.importMode).toBe('move')
    expect(body.files).toHaveLength(1)
    expect(body.files[0]).toMatchObject({
      path: '/downloads/Ep.mkv',
      seriesId: 3,
      episodeIds: [11, 12],
      downloadId: 'dl-2',
      quality: { quality: { id: 4 } },
      languages: [{ id: 1, name: 'English' }],
    })
  })

  test('falls back to release season and episode when Sonarr cannot parse episode ids', async () => {
    let commandBody: unknown = null
    server.use(
      http.get(`${SONARR_URL}/api/v3/manualimport`, () => HttpResponse.json([
        { path: '/downloads/Ep.mkv', quality: { quality: { id: 4 } }, languages: [{ id: 1, name: 'English' }], releaseGroup: 'GRP', episodes: [] },
      ])),
      http.get(`${SONARR_URL}/api/v3/episode`, () => HttpResponse.json([
        { id: 22, seasonNumber: 1, episodeNumber: 2 },
      ])),
      http.post(`${SONARR_URL}/api/v3/command`, async ({ request }) => {
        commandBody = await request.json()
        return HttpResponse.json({ id: 2 })
      }),
    )

    const sonarr = makeSonarr()
    const commandId = await sonarr.manualImport({
      folder: '/downloads',
      paths: ['/downloads/Ep.mkv'],
      target: { kind: 'series', seriesId: 3 },
      downloadId: 'dl-2',
      release: { season: 1, episode: 2 },
    })

    const body = CommandBody.parse(commandBody)
    expect(commandId).toBe(2)
    expect(body.files[0]).toMatchObject({
      path: '/downloads/Ep.mkv',
      seriesId: 3,
      episodeIds: [22],
      downloadId: 'dl-2',
    })
  })

  test('throws BadRequestError when given a movie target', async () => {
    const sonarr = makeSonarr()
    await expect(sonarr.manualImport({
      folder: '/downloads',
      paths: ['/downloads/Ep.mkv'],
      target: { kind: 'movie', movieId: 1 },
      downloadId: 'dl-2',
    })).rejects.toThrow(BadRequestError)
  })
})

describe('manualImportCommandStatus', () => {
  test('reports completed/failed/pending from the command status', async () => {
    server.use(
      http.get(`${RADARR_URL}/api/v3/command/1`, () => HttpResponse.json({ id: 1, status: 'completed' })),
      http.get(`${RADARR_URL}/api/v3/command/2`, () => HttpResponse.json({ id: 2, status: 'failed', message: 'boom' })),
      http.get(`${RADARR_URL}/api/v3/command/3`, () => HttpResponse.json({ id: 3, status: 'started' })),
    )
    const radarr = makeRadarr()
    expect(await radarr.manualImportCommandStatus(1)).toEqual({ state: 'completed' })
    expect(await radarr.manualImportCommandStatus(2)).toEqual({ state: 'failed', error: 'boom' })
    expect(await radarr.manualImportCommandStatus(3)).toEqual({ state: 'pending' })
  })

  // A pruned command record (404) is terminal, not transient: returning `failed`
  // lets the watcher fail the row instead of polling a vanished id forever.
  test('returns failed when the command record was pruned (404)', async () => {
    server.use(
      http.get(`${RADARR_URL}/api/v3/command/9`, () => new HttpResponse(null, { status: 404 })),
    )
    const radarr = makeRadarr()
    const status = await radarr.manualImportCommandStatus(9)
    expect(status.state).toBe('failed')
    expect(status).toMatchObject({ error: expect.stringContaining('no longer exists') })
  })

  // A transient failure (5xx, timeout) must keep throwing so the watcher retries.
  test('rethrows non-404 errors so the watcher retries next tick', async () => {
    server.use(
      http.get(`${RADARR_URL}/api/v3/command/8`, () => new HttpResponse(null, { status: 503 })),
    )
    const radarr = makeRadarr()
    await expect(radarr.manualImportCommandStatus(8)).rejects.toThrow()
  })
})
