import process from 'node:process'
import { getApp } from './app'
import { openDatabase } from './database/connection'
import { shutdownTelemetry } from './instrumentation'
import { getAppConfig } from './lib/config'
import { getAppEnvs } from './lib/envs'
import { FetchError } from './lib/errors/FetchError'
import { initializeConnectors } from './lib/servers'
import { logger } from './logger'
import { BlackholeWatcher } from './modules/downloads/blackhole.watcher'
import { DownloadsRepository } from './modules/downloads/downloads.repository'
import { DownloadsService } from './modules/downloads/downloads.service'

function logRegistrationFailure(what: string, destName: string | undefined, err: unknown) {
  if (err instanceof FetchError) {
    logger.error({ destination: destName, status: err.extras.status, body: err.extras.body }, `Failed to register ${what}`)
    return
  }
  const message = err instanceof Error ? err.message : String(err)
  logger.error({ destination: destName, error: message }, `Failed to register ${what}`)
}

logger.debug('Loading environment variables')
const envs = getAppEnvs()

logger.debug('Loading app config')
const config = await getAppConfig(envs)

const connectors = await initializeConnectors(config)
const destinations = connectors.servers.filter(s => s.canDestination)

const database = await openDatabase({ appConfigPath: envs.APP_CONFIG_PATH })
const downloadsRepository = new DownloadsRepository(database.db)
const reconciledDownloads = await downloadsRepository.reconcileStaleDownloads()

if (reconciledDownloads > 0)
  logger.warn({ downloads: reconciledDownloads, databasePath: database.path }, 'Reconciled stale downloads from previous Jack run')

const app = getApp(envs, config, connectors, { downloadsRepository })
const server = Bun.serve({
  fetch: app.fetch,
})

logger.info({
  port: server.port,
  configPath: envs.APP_CONFIG_PATH,
  databasePath: database.path,
  sources: connectors.servers.filter(c => c.isInitialized && c.canSource).length,
  peers: connectors.peers.filter(c => c.isInitialized).length,
  destinations: destinations.filter(c => c.isInitialized).length,
}, 'Server listening')

// Auto-register as Torznab indexer (and Torrent Blackhole download client) in
// each destination that opts in via its `autoregister` config.
if (config.jack) {
  // Without peers there's nothing to search and nothing to grab, and *arr rejects
  // an indexer whose test query returns no results — so skip registration entirely.
  if (connectors.peers.length === 0) {
    logger.info('No peers configured; skipping indexer and download client registration (nothing to search or grab yet).')
  }
  else {
    const jackConfig = config.jack
    const downloads = config.downloads

    if (!downloads) {
      logger.warn('No "downloads" config set; skipping download client auto-registration. Grabs will fail until a Torrent Blackhole client is configured.')
    }

    const registrable = destinations.filter(d => d.isInitialized && d.autoRegister.enable)
    for (const dest of registrable) {
      try {
        await dest.registerIndexer({
          name: 'Jack',
          baseUrl: `${jackConfig.baseUrl}/torznab`,
          apiKey: jackConfig.apiKey,
          priority: dest.autoRegister.priority,
          categories: dest.categories,
        })
        logger.info({ destination: dest.name, categories: dest.categories }, 'Registered Jack as Torznab indexer')
      }
      catch (err) {
        logRegistrationFailure('indexer', dest.name, err)
      }

      if (downloads) {
        try {
          await dest.registerDownloadClient({
            name: 'Jack',
            watchPath: downloads.watchPath,
            completedPath: downloads.completedPath,
            priority: dest.autoRegister.priority,
          })
          logger.info({ destination: dest.name }, 'Registered Jack as Torrent Blackhole download client')
        }
        catch (err) {
          logRegistrationFailure('download client', dest.name, err)
        }
      }
    }
  }
}

// Start blackhole watcher
let blackholeWatcher: BlackholeWatcher | null = null
if (config.downloads) {
  const downloadsService = new DownloadsService(config.downloads, connectors.peers, destinations, downloadsRepository)
  blackholeWatcher = new BlackholeWatcher(config.downloads, downloadsService)
  await blackholeWatcher.start()
}

process.on('SIGINT', async () => {
  logger.info('SIGINT received, exiting')
  blackholeWatcher?.stop()
  database.close()
  server.stop()
  await shutdownTelemetry()
  process.exit(0)
})

process.on('SIGTERM', async () => {
  logger.info('SIGTERM received, exiting')
  blackholeWatcher?.stop()
  database.close()
  server.stop()
  await shutdownTelemetry()
  process.exit(0)
})
