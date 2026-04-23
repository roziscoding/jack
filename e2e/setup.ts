import { join } from 'node:path'
import { waitForUrl, retry, fetchJson } from './helpers'

const JELLYFIN_URL = 'http://localhost:18096'
const RADARR_URL = 'http://localhost:17878'
const SONARR_URL = 'http://localhost:18989'

const CONFIG_DIR = join(import.meta.dir, 'config')

async function bootstrapJellyfin(): Promise<string> {
  console.log('⏳ Waiting for Jellyfin...')
  await waitForUrl(`${JELLYFIN_URL}/health`)

  // Wait for Jellyfin to be fully loaded (not just healthy)
  await retry(async () => {
    const info = await fetchJson<{ StartupWizardCompleted: boolean }>(`${JELLYFIN_URL}/System/Info/Public`)
    if (!info) throw new Error('Jellyfin not ready')
  }, { retries: 30, delay: 2_000 })
  console.log('✅ Jellyfin is up')

  // Check if startup wizard is already done
  const info = await fetchJson<{ StartupWizardCompleted: boolean }>(`${JELLYFIN_URL}/System/Info/Public`)

  if (!info.StartupWizardCompleted) {
    // Complete startup wizard — each step must succeed before the next
    await retry(async () => {
      const res = await fetch(`${JELLYFIN_URL}/Startup/Configuration`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          UICulture: 'en-US',
          MetadataCountryCode: 'US',
          PreferredMetadataLanguage: 'en',
        }),
      })
      if (!res.ok) throw new Error(`Startup/Configuration: ${res.status}`)
    }, { retries: 15, delay: 3_000 })

    // Wait for Jellyfin to create its default user before we can update it
    await retry(async () => {
      const res = await fetch(`${JELLYFIN_URL}/Startup/User`)
      if (!res.ok) throw new Error(`GET Startup/User: ${res.status}`)
      const user = await res.json() as { Name: string }
      if (!user.Name) throw new Error('Default user not ready')
      console.log(`  Default user found: ${user.Name}`)
    }, { retries: 30, delay: 3_000 })

    await retry(async () => {
      const res = await fetch(`${JELLYFIN_URL}/Startup/User`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ Name: 'admin', Password: 'test1234' }),
      })
      if (!res.ok) throw new Error(`Startup/User: ${res.status}`)
    }, { retries: 15, delay: 3_000 })

    await Bun.sleep(2_000)

    await retry(async () => {
      const res = await fetch(`${JELLYFIN_URL}/Startup/Complete`, { method: 'POST' })
      if (!res.ok) throw new Error(`Startup/Complete: ${res.status}`)
    }, { retries: 15, delay: 3_000 })
    console.log('✅ Jellyfin startup wizard completed')
  }

  // Authenticate to get API key
  const authRes = await retry(() => fetchJson<{ AccessToken: string }>(`${JELLYFIN_URL}/Users/AuthenticateByName`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'MediaBrowser Client="Jack E2E", Device="Test", DeviceId="jack-e2e-test", Version="1.0"',
    },
    body: JSON.stringify({ Username: 'admin', Pw: 'test1234' }),
  }))

  const apiKey = authRes.AccessToken
  console.log('✅ Jellyfin authenticated')

  // Create movie library
  const movieParams = new URLSearchParams({
    name: 'Movies',
    collectionType: 'movies',
    refreshLibrary: 'true',
    api_key: apiKey,
  })
  await fetch(`${JELLYFIN_URL}/Library/VirtualFolders?${movieParams}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      LibraryOptions: {
        PathInfos: [{ Path: '/media/movies' }],
        EnableRealtimeMonitor: false,
      },
    }),
  })

  // Create TV library
  const tvParams = new URLSearchParams({
    name: 'TV',
    collectionType: 'tvshows',
    refreshLibrary: 'true',
    api_key: apiKey,
  })
  await fetch(`${JELLYFIN_URL}/Library/VirtualFolders?${tvParams}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      LibraryOptions: {
        PathInfos: [{ Path: '/media/tv' }],
        EnableRealtimeMonitor: false,
      },
    }),
  })

  console.log('⏳ Waiting for Jellyfin library scan...')
  await retry(async () => {
    const items = await fetchJson<{ TotalRecordCount: number }>(`${JELLYFIN_URL}/Items?recursive=true&api_key=${apiKey}`)
    if (items.TotalRecordCount < 1) throw new Error(`Library scan incomplete: ${items.TotalRecordCount} items`)
  }, { retries: 30, delay: 3_000 })

  console.log('✅ Jellyfin libraries ready')

  // Set provider IDs on the movie for IMDB search testing
  const movieItems = await fetchJson<{ Items: Array<{ Id: string, Name: string }> }>(
    `${JELLYFIN_URL}/Items?searchTerm=Big%20Buck&recursive=true&api_key=${apiKey}`,
  )
  const movie = movieItems.Items.find(i => i.Name.includes('Big Buck Bunny'))
  if (movie) {
    await fetch(`${JELLYFIN_URL}/Items/${movie.Id}?api_key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        Id: movie.Id,
        Name: 'Big Buck Bunny',
        ProviderIds: { Imdb: 'tt1254207' },
      }),
    })
    console.log('✅ Set IMDB provider ID on movie')
  }

  return apiKey
}

async function extractApiKey(service: string, url: string, port: number): Promise<string> {
  console.log(`⏳ Waiting for ${service}...`)
  await waitForUrl(`${url}/ping`)
  console.log(`✅ ${service} is up`)

  // Extract API key from config.xml inside container
  const containerName = `e2e-${service.toLowerCase()}-1`
  const result = await Bun.$`docker compose -f ${join(import.meta.dir, 'docker-compose.yml')} exec ${service.toLowerCase()} cat /config/config.xml`.text()
  const match = result.match(/<ApiKey>([^<]+)<\/ApiKey>/)
  if (!match) throw new Error(`Could not extract API key from ${service}`)

  console.log(`✅ ${service} API key extracted`)
  return match[1]
}

async function writeJackConfigs(jellyfinApiKey: string, radarrApiKey: string, sonarrApiKey: string) {
  const alphaConfig = {
    jack: {
      baseUrl: 'http://jack-alpha:3000',
      apiKey: 'alpha-test-key',
      mediaPath: '/media',
    },
    indexer: { priority: 1, autoRegister: true },
    servers: {
      sources: [
        { type: 'jellyfin', url: 'http://jellyfin:8096', apiKey: jellyfinApiKey, name: 'Test Jellyfin' },
      ],
      peers: [],
      destinations: [
        { type: 'radarr', url: 'http://radarr:7878', apiKey: radarrApiKey, name: 'Test Radarr' },
        { type: 'sonarr', url: 'http://sonarr:8989', apiKey: sonarrApiKey, name: 'Test Sonarr' },
      ],
    },
  }

  const betaConfig = {
    jack: {
      baseUrl: 'http://jack-beta:3000',
      apiKey: 'beta-test-key',
      mediaPath: '/media',
    },
    indexer: { priority: 1, autoRegister: true },
    downloads: {
      watchPath: '/downloads/watch',
      completedPath: '/downloads/completed',
    },
    servers: {
      sources: [],
      peers: [
        { url: 'http://jack-alpha:3000', apiKey: 'alpha-test-key', name: 'Jack Alpha' },
      ],
      destinations: [
        { type: 'radarr', url: 'http://radarr:7878', apiKey: radarrApiKey, name: 'Test Radarr' },
      ],
    },
  }

  await Bun.write(join(CONFIG_DIR, 'jack-alpha.jsonc'), JSON.stringify(alphaConfig, null, 2))
  await Bun.write(join(CONFIG_DIR, 'jack-beta.jsonc'), JSON.stringify(betaConfig, null, 2))
  console.log('✅ Jack config files written')

  // Write test-env.json for tests to consume
  const testEnv = {
    jellyfinUrl: JELLYFIN_URL,
    jellyfinApiKey,
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

  const jellyfinApiKey = await bootstrapJellyfin()
  const radarrApiKey = await extractApiKey('Radarr', RADARR_URL, 17878)
  const sonarrApiKey = await extractApiKey('Sonarr', SONARR_URL, 18989)

  await writeJackConfigs(jellyfinApiKey, radarrApiKey, sonarrApiKey)

  console.log('\n✅ Setup complete! Jack instances will start automatically.')
}

main().catch((err) => {
  console.error('❌ Setup failed:', err)
  process.exit(1)
})
