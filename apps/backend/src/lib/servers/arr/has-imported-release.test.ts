import type { Release } from '../../release'
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { http, HttpResponse } from 'msw'
import { setupServer } from 'msw/node'
import { ReleaseCategory } from '../../release'
import { SonarrServerConnector } from './sonarr'

const SONARR_URL = 'http://sonarr.test:8989'
const HEX_KEY = 'a'.repeat(32)
const AUTOREGISTER = { enable: true, priority: 1 }

const handlers = [
  http.get(`${SONARR_URL}/api/v3/system/status`, () => HttpResponse.json({ appName: 'Sonarr', version: '4.0.0' })),
  http.get(`${SONARR_URL}/api/v3/series/10`, () => HttpResponse.json({ id: 10, title: 'Show', tvdbId: 1 })),
]

const server = setupServer(...handlers)
beforeAll(() => server.listen({ onUnhandledRequest: 'bypass' }))
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

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

// The queued release is S01E05 from group GRP at Remux-2160p.
const queued: Release = {
  id: 's',
  title: 'Show.S01E05.2160p.REMUX-GRP',
  filename: 'Show.S01E05.mkv',
  category: ReleaseCategory.Tv,
  size: 1000,
  releaseGroup: 'GRP',
  quality: { name: 'Remux-2160p' },
  season: 1,
  episode: 5,
}

function episodesHandler(episodes: unknown[]) {
  return http.get(`${SONARR_URL}/api/v3/episode`, () => HttpResponse.json(episodes))
}

describe('SonarrServerConnector.hasImportedRelease', () => {
  test('does not retire the row when only a sibling episode (same group+quality) is on disk', async () => {
    // S01E03 shares the release group and quality tier but is a different episode;
    // the coarse group+quality fallback must never see it, so we scope to E05.
    server.use(episodesHandler([
      {
        id: 53,
        seasonNumber: 1,
        episodeNumber: 3,
        hasFile: true,
        episodeFile: { size: 2000, releaseGroup: 'GRP', quality: { quality: { name: 'Remux-2160p' } }, path: '/tv/Show/s01e03.mkv' },
      },
      { id: 55, seasonNumber: 1, episodeNumber: 5, hasFile: false },
    ]))

    expect(await makeSonarr().hasImportedRelease({ kind: 'series', seriesId: 10 }, queued)).toBe(false)
  })

  test('retires the row when the queued episode itself is on disk (size match)', async () => {
    server.use(episodesHandler([
      {
        id: 55,
        seasonNumber: 1,
        episodeNumber: 5,
        hasFile: true,
        episodeFile: { size: 1000, releaseGroup: 'GRP', quality: { quality: { name: 'Remux-2160p' } }, path: '/tv/Show/s01e05.mkv' },
      },
    ]))

    expect(await makeSonarr().hasImportedRelease({ kind: 'series', seriesId: 10 }, queued)).toBe(true)
  })
})
