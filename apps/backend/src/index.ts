import process from 'node:process'
import { getApp } from './app'
import { getAppConfig } from './lib/config'
import { getAppEnvs } from './lib/envs'
import { FetchError } from './lib/errors/FetchError'
import { initializeConnectors } from './lib/servers'
import { BlackholeWatcher } from './modules/downloads/blackhole'
import { logger } from './logger'

// Surface the *arr response body (which carries the actual validation message)
// instead of just "Bad Request" — registration failures are almost always a
// validation/test error Radarr/Sonarr return in the 400 body.
function logRegistrationFailure(what: string, destName: string | undefined, err: unknown) {
  if (err instanceof FetchError) {
    logger.error({ destination: destName, status: err.status, body: err.extras.body }, `Failed to register ${what}`)
    return
  }
  const message = err instanceof Error ? err.message : String(err)
  logger.error({ destination: destName, error: message }, `Failed to register ${what}`)
}

logger.debug('Loading environment variables')
const envs = getAppEnvs()

logger.debug('Loading app config')
const config = await getAppConfig(envs)

const connectors = await initializeConnectors(config.servers)

const app = getApp(config, connectors)
const server = Bun.serve({
  fetch: app.fetch,
})

logger.info({
  port: server.port,
  configPath: envs.APP_CONFIG_PATH,
  sources: connectors.sources.filter(c => c.isInitialized).length,
  peers: connectors.peers.filter(c => c.isInitialized).length,
  destinations: connectors.destinations.filter(c => c.isInitialized).length,
}, 'Server listening')

// Auto-register as Torznab indexer (and Torrent Blackhole download client) in Radarr/Sonarr.
if (config.jack && config.indexer?.autoRegister !== false) {
  // Without peers there's nothing to search and nothing to grab, and *arr rejects
  // an indexer whose test query returns no results — so skip registration entirely.
  if (connectors.peers.length === 0) {
    logger.info('No peers configured; skipping indexer and download client registration (nothing to search or grab yet).')
  } else {
    const jackConfig = config.jack
    const indexerConfig = config.indexer ?? { priority: 1, autoRegister: true }
    const downloads = config.downloads

    if (!downloads) {
      logger.warn('No "downloads" config set; skipping download client auto-registration. Grabs will fail until a Torrent Blackhole client is configured.')
    }

    for (const dest of connectors.destinations.filter(d => d.isInitialized)) {
      const categories = dest.type === 'radarr' ? [2000] : [5000]
      try {
        await dest.registerIndexer({
          name: 'Jack',
          baseUrl: `${jackConfig.baseUrl}/torznab`,
          apiKey: jackConfig.apiKey,
          priority: indexerConfig.priority,
          categories,
        })
        logger.info({ destination: dest.name, categories }, 'Registered Jack as Torznab indexer')
      } catch (err) {
        logRegistrationFailure('indexer', dest.name, err)
      }

      if (downloads) {
        try {
          await dest.registerDownloadClient({
            name: 'Jack',
            watchPath: downloads.watchPath,
            completedPath: downloads.completedPath,
            priority: indexerConfig.priority,
          })
          logger.info({ destination: dest.name }, 'Registered Jack as Torrent Blackhole download client')
        } catch (err) {
          logRegistrationFailure('download client', dest.name, err)
        }
      }
    }
  }
}

// Start blackhole watcher
let blackhole: BlackholeWatcher | null = null
if (config.downloads) {
  blackhole = new BlackholeWatcher(config.downloads, connectors.peers, connectors.destinations)
  await blackhole.start()
}

process.on('SIGINT', () => {
  logger.info('SIGINT received, exiting')
  blackhole?.stop()
  server.stop()
  process.exit(0)
})

process.on('SIGTERM', () => {
  logger.info('SIGTERM received, exiting')
  blackhole?.stop()
  server.stop()
  process.exit(0)
})
