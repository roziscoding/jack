import { join } from 'node:path'
import { fetchJson, retry, waitForUrl } from './helpers'

const RADARR_URL = 'http://localhost:17878'
const SONARR_URL = 'http://localhost:18989'

const CONFIG_DIR = join(import.meta.dir, 'config')

// Big Buck Bunny — a real, freely-licensed film present in TMDb, matching the
// fixture at fixtures/media/movies/Big Buck Bunny (2008)/Big Buck Bunny.mkv.
const BIG_BUCK_TMDB_ID = 10378

async function extractApiKey(service: 'Radarr' | 'Sonarr', url: string): Promise<string> {
  console.log(`⏳ Waiting for ${service}...`)
  await waitForUrl(`${url}/ping`)
  console.log(`✅ ${service} is up`)

  // Extract API key from config.xml inside the container.
  const result = await Bun.$`docker compose -f ${join(import.meta.dir, 'docker-compose.yml')} exec ${service.toLowerCase()} cat /config/config.xml`.text()
  const match = result.match(/<ApiKey>([^<]+)<\/ApiKey>/)
  const apiKey = match?.[1]
  if (!apiKey) throw new Error(`Could not extract API key from ${service}`)

  console.log(`✅ ${service} API key extracted`)
  return apiKey
}

// Seed Radarr with the fixture movie so jack-alpha has something to share. We
// add the movie, point it at the mounted fixtures root, then rescan so Radarr
// detects the existing file and flags it as `hasFile`.
async function seedRadarrMovie(apiKey: string) {
  const headers = { 'X-Api-Key': apiKey, 'Content-Type': 'application/json' }

  // `/ping` comes up before the API has finished migrating; until then the v3
  // endpoints return 400/503. Poll the authenticated status endpoint first.
  console.log('⏳ Waiting for Radarr API to be ready...')
  await retry(async () => {
    const res = await fetch(`${RADARR_URL}/api/v3/system/status`, { headers })
    if (!res.ok) throw new Error(`Radarr API not ready: ${res.status}`)
  }, { retries: 30, delay: 2_000 })

  await fetch(`${RADARR_URL}/api/v3/rootfolder`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ path: '/media/movies' }),
  }).catch(() => {})

  const profiles = await fetchJson<Array<{ id: number }>>(`${RADARR_URL}/api/v3/qualityprofile`, { headers })
  const qualityProfileId = profiles[0]?.id ?? 1

  const existing = await fetchJson<Array<{ tmdbId: number, id: number }>>(`${RADARR_URL}/api/v3/movie`, { headers })
  let movieId = existing.find(m => m.tmdbId === BIG_BUCK_TMDB_ID)?.id

  if (!movieId) {
    const added = await fetchJson<{ id: number }>(`${RADARR_URL}/api/v3/movie`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        tmdbId: BIG_BUCK_TMDB_ID,
        title: 'Big Buck Bunny',
        qualityProfileId,
        rootFolderPath: '/media/movies',
        monitored: true,
        minimumAvailability: 'released',
        addOptions: { searchForMovie: false },
      }),
    })
    movieId = added.id
    console.log(`✅ Added Big Buck Bunny to Radarr (movieId=${movieId})`)
  }

  await fetch(`${RADARR_URL}/api/v3/command`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ name: 'RescanMovie', movieId }),
  })

  console.log('⏳ Waiting for Radarr to detect the movie file...')
  await retry(async () => {
    const movie = await fetchJson<{ hasFile: boolean }>(`${RADARR_URL}/api/v3/movie/${movieId}`, { headers })
    if (!movie.hasFile) throw new Error('movie file not detected yet')
  }, { retries: 30, delay: 2_000 })

  console.log('✅ Radarr library seeded')
}

async function writeJackConfigs(radarrApiKey: string, sonarrApiKey: string) {
  // jack-alpha shares its Radarr/Sonarr library with peers (source only).
  const alphaConfig = {
    jack: { baseUrl: 'http://jack-alpha:3000', apiKey: 'alpha-test-key' },
    servers: [
      { type: 'radarr', url: 'http://radarr:7878', apiKey: radarrApiKey, name: 'Test Radarr', source: true, destination: false },
      { type: 'sonarr', url: 'http://sonarr:8989', apiKey: sonarrApiKey, name: 'Test Sonarr', source: true, destination: false },
    ],
    peers: [],
  }

  // jack-beta searches jack-alpha and registers itself into its own Radarr.
  const betaConfig = {
    jack: { baseUrl: 'http://jack-beta:3000', apiKey: 'beta-test-key' },
    downloads: { watchPath: '/downloads/watch', completedPath: '/downloads/completed' },
    servers: [
      { type: 'radarr', url: 'http://radarr:7878', apiKey: radarrApiKey, name: 'Test Radarr', source: false, destination: true },
    ],
    peers: [
      { url: 'http://jack-alpha:3000', apiKey: 'alpha-test-key', name: 'Jack Alpha' },
    ],
  }

  await Bun.write(join(CONFIG_DIR, 'jack-alpha.jsonc'), JSON.stringify(alphaConfig, null, 2))
  await Bun.write(join(CONFIG_DIR, 'jack-beta.jsonc'), JSON.stringify(betaConfig, null, 2))
  console.log('✅ Jack config files written')

  const testEnv = {
    radarrUrl: RADARR_URL,
    radarrApiKey,
    sonarrUrl: SONARR_URL,
    sonarrApiKey,
    jackAlphaUrl: 'http://localhost:13000',
    jackAlphaApiKey: 'alpha-test-key',
    jackBetaUrl: 'http://localhost:13001',
    jackBetaApiKey: 'beta-test-key',
  }

  await Bun.write(join(CONFIG_DIR, 'test-env.json'), JSON.stringify(testEnv, null, 2))
  console.log('✅ test-env.json written')
}

async function main() {
  console.log('🚀 Setting up e2e environment...\n')

  const radarrApiKey = await extractApiKey('Radarr', RADARR_URL)
  const sonarrApiKey = await extractApiKey('Sonarr', SONARR_URL)

  await seedRadarrMovie(radarrApiKey)
  await writeJackConfigs(radarrApiKey, sonarrApiKey)

  console.log('\n✅ Setup complete! Jack instances will start automatically.')
}

main().catch((err) => {
  console.error('❌ Setup failed:', err)
  process.exit(1)
})
