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
import { qbCategoryForServer } from './modules/qbittorrent/qbittorrent.mapper'

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

const downloadsService = config.downloads
  ? new DownloadsService(config.downloads, connectors.peers, destinations, downloadsRepository)
  : undefined

const app = getApp(envs, config, connectors, { downloadsRepository, downloadsService })
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
      logger.warn('No "downloads" config set; skipping download client auto-registration. Grabs will fail until a qBittorrent client is configured.')
    }

    const registrable = destinations.filter(d => d.isInitialized && d.autoRegister.enable)
    for (const dest of registrable) {
      // Register the download client first so we can bind the indexer to it:
      // grabs from the Jack indexer must go to the Jack qBittorrent client, not
      // whatever client *arr would otherwise pick.
      let downloadClientId: number | undefined
      if (downloads) {
        try {
          downloadClientId = await dest.registerDownloadClient({
            name: 'Jack',
            baseUrl: jackConfig.baseUrl,
            username: dest.name,
            password: jackConfig.apiKey,
            category: qbCategoryForServer(dest.id),
            priority: dest.autoRegister.priority,
          })
          logger.info({ destination: dest.name, downloadClientId }, 'Registered Jack as qBittorrent download client')
        }
        catch (err) {
          logRegistrationFailure('download client', dest.name, err)
        }
      }

      try {
        await dest.registerIndexer({
          name: 'Jack',
          baseUrl: `${jackConfig.baseUrl}/torznab`,
          apiKey: jackConfig.apiKey,
          priority: dest.autoRegister.priority,
          categories: dest.categories,
          downloadClientId,
        })
        logger.info({ destination: dest.name, categories: dest.categories, downloadClientId }, 'Registered Jack as Torznab indexer')
      }
      catch (err) {
        logRegistrationFailure('indexer', dest.name, err)
      }
    }
  }
}

// Start blackhole watcher (and re-drive interrupted downloads from a prior run)
let blackholeWatcher: BlackholeWatcher | null = null
if (config.downloads && downloadsService) {
  // Active re-enqueue: resume stale `downloading` rows in place before the
  // watcher scans, so the leftover .torrent stubs are not re-processed as new rows.
  const resumed = await downloadsService.resumeStaleDownloads()
  if (resumed > 0)
    logger.warn({ downloads: resumed, databasePath: database.path }, 'Re-enqueued interrupted downloads from previous Jack run')

  blackholeWatcher = new BlackholeWatcher(config.downloads, downloadsService)
  await blackholeWatcher.start()
}
else {
  // No downloads config means stale rows cannot be resumed — mark them failed.
  const failed = await downloadsRepository.reconcileStaleDownloads()
  if (failed > 0)
    logger.warn({ downloads: failed, databasePath: database.path }, 'Marked stale downloads failed (no downloads config to resume them)')
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
