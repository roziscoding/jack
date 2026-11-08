import process from 'node:process'
import { getApp } from './app'
import { openDatabase } from './database/connection'
import { shutdownTelemetry } from './instrumentation'
import { registerManagedForDestination } from './lib/autoregister'
import { getAppConfig } from './lib/config'
import { getAppEnvs } from './lib/envs'
import { FetchError } from './lib/errors/FetchError'
import { ConnectorManager } from './lib/servers'
import { PROTOCOL_VERSION } from './lib/version'
import { logger } from './logger'
import { getManagementApp } from './management-app'
import { ApiKeysRepository } from './modules/api-keys/api-keys.repository'
import { CatalogCacheRepository } from './modules/catalog/catalog-cache.repository'
import { CatalogSyncService } from './modules/catalog/catalog-sync.service'
import { OwnCatalogRepository } from './modules/catalog/own-catalog.repository'
import { TmdbMetadataRepository } from './modules/catalog/tmdb-metadata.repository'
import { ConfigService } from './modules/config/config.service'
import { DownloadsManagementController } from './modules/downloads/downloads.controller'
import { DownloadsRepository } from './modules/downloads/downloads.repository'
import { DownloadsService } from './modules/downloads/downloads.service'
import { FailedDownloadReaper } from './modules/downloads/failed-download-reaper'
import { ImportWatcher } from './modules/downloads/import-watcher'
import { ManagedKeysRepository } from './modules/managed-keys/managed-keys.repository'
import { ManagedApiKeys } from './modules/managed-keys/managed-keys.service'
import { qbCategoryForServer } from './modules/qbittorrent/qbittorrent.mapper'
import { StatsRepository } from './modules/stats/stats.repository'
import { UploadsRepository } from './modules/uploads/uploads.repository'
import { UploadsService } from './modules/uploads/uploads.service'

function logRegistrationFailure(what: string, destName: string | undefined, err: unknown) {
  if (err instanceof FetchError) {
    logger.error({ destination: destName, status: err.extras.status, body: err.extras.body }, `Failed to register ${what}`)
    return
  }
  const message = err instanceof Error
    ? err.message
    : String(err)
  logger.error({ destination: destName, error: message }, `Failed to register ${what}`)
}

logger.debug('Loading environment variables')
const envs = getAppEnvs()

logger.debug('Loading app config')
const { appConfig: config, raw: rawConfig } = await getAppConfig(envs)

const connectorManager = new ConnectorManager(config.servers, config.peers)
await connectorManager.initAll()

const database = await openDatabase({ appConfigPath: envs.APP_CONFIG_PATH })
const downloadsRepository = new DownloadsRepository(database.db)
const apiKeysRepository = new ApiKeysRepository(database.db)
const managedKeysRepository = new ManagedKeysRepository(database.db)
const catalogCacheRepository = new CatalogCacheRepository(database.db)
const tmdbMetadataRepository = new TmdbMetadataRepository(database.db)
const uploadsService = new UploadsService(new UploadsRepository(database.db))
const statsRepository = new StatsRepository(database.db)

// Peers connected to the previous run lost those transfers with it.
const interruptedUploads = uploadsService.repository.reconcileInterrupted()
if (interruptedUploads > 0)
  logger.warn({ uploads: interruptedUploads }, 'Marked uploads interrupted by the previous jack run as aborted')
// A receipt that never came (a lost POST) shouldn't leave an upload running forever.
setInterval(() => uploadsService.expireUnconfirmed(), 60 * 60 * 1000).unref()

// Seed the management service from the shared raw object returned by getAppConfig
// so the service's persisted state can never diverge from the loaded runtime config.
const configService = envs.MANAGEMENT_KEY
  ? new ConfigService({
      path: envs.APP_CONFIG_PATH,
      raw: rawConfig,
      connectorManager,
      downloadsRepository,
    })
  : undefined

const downloadsService = config.downloads
  ? new DownloadsService(config.downloads, connectorManager, downloadsRepository)
  : undefined

// Keeps this instance's catalog (served to peers) and every peer's (searched by
// the Peer Catalog) current: once at boot, then on the configured cron schedule.
const ownCatalogRepository = new OwnCatalogRepository(database.db)
const catalogSync = new CatalogSyncService({
  connectors: connectorManager,
  own: ownCatalogRepository,
  peerCache: catalogCacheRepository,
  metadata: tmdbMetadataRepository,
  schedule: () => configService?.getCatalog().refreshSchedule ?? config.catalog.refreshSchedule,
  // Record today's catalog sizes for the dashboard's history chart.
  onSynced: () => {
    try {
      statsRepository.recordCatalogSizes(new Map(connectorManager.peers.map(p => [p.id, p.name ?? p.url])))
    }
    catch (err) {
      logger.warn({ err }, 'Could not record catalog sizes')
    }
  },
})
catalogSync.start()
// A schedule edited in the UI applies without a restart.
configService?.subscribe(() => catalogSync.reschedule())

const app = getApp(envs, config, connectorManager, {
  downloadsRepository,
  downloadsService,
  apiKeysRepository,
  managedKeysRepository,
  ownCatalogRepository,
  uploadsService,
})
const server = Bun.serve({
  fetch: app.fetch,
})

logger.info({
  version: PROTOCOL_VERSION,
  port: server.port,
  configPath: envs.APP_CONFIG_PATH,
  databasePath: database.path,
  sources: connectorManager.sources.length,
  peers: connectorManager.peers.length,
  destinations: connectorManager.destinations.length,
}, 'Server listening')

// Detect *arr imports of finished downloads and flip them import_queued → imported.
// Construct this before the management app so failed imports can be retried there.
const downloadsConfig = config.downloads
const importWatcher = downloadsConfig
  ? new ImportWatcher(downloadsRepository, connectorManager, downloadsConfig.importPollIntervalMs, {
      maxAttempts: downloadsConfig.maxManualImportAttempts,
      backoffBaseMs: downloadsConfig.manualImportBackoffBaseMs,
      backoffMaxMs: downloadsConfig.manualImportBackoffMaxMs,
    }, undefined, {
      // Read per import, from the file when the management API can rewrite it, so
      // toggling it in the UI applies without a restart. completedPath still comes
      // from the boot config — it's the root every unlink is confined to.
      enabled: () => configService?.getRawDownloads()?.unlinkImportedFiles ?? downloadsConfig.unlinkImportedFiles,
      completedPath: downloadsConfig.completedPath,
    }, (release) => {
      // Show the import in the catalog now instead of on the next scheduled sync.
      void catalogSync.addImported(release)
    })
  : undefined

// Retries failed downloads with backoff, then deletes the ones that keep failing.
// Routed through the management controller so transfers and imports each retry the
// way the ***Retry*** button does.
const downloadsController = new DownloadsManagementController(downloadsRepository, downloadsService, importWatcher)
const failedDownloadReaper = downloadsConfig
  ? new FailedDownloadReaper({
      // Read per tick, like unlinkImportedFiles, so the UI toggle applies live.
      enabled: () => configService?.getRawDownloads()?.removeFailedDownloads ?? downloadsConfig.removeFailedDownloads,
      list: () => downloadsRepository.list(),
      retry: id => downloadsController.retry(id),
      remove: id => downloadsController.delete(id),
      maxRetries: downloadsConfig.failedDownloadRetries,
      baseDelayMs: downloadsConfig.failedRetryBaseDelayMs,
      maxDelayMs: downloadsConfig.retryMaxDelayMs,
    })
  : undefined

function startManagementServer() {
  if (!envs.MANAGEMENT_KEY)
    return undefined

  if (envs.MANAGEMENT_PORT === server.port) {
    logger.error({ port: envs.MANAGEMENT_PORT }, 'MANAGEMENT_PORT collides with the public port; not starting the management API')
    return undefined
  }

  const managementApp = getManagementApp({
    environment: envs.ENVIRONMENT,
    managementKey: envs.MANAGEMENT_KEY,
    connectors: connectorManager,
    configService,
    downloadsRepository,
    downloadsService,
    importWatcher,
    uploadsService,
    statsRepository,
    apiKeysRepository,
    catalogCacheRepository,
    tmdbMetadataRepository,
    catalogSync,
    tmdbApiKey: config.jack.tmdbApiKey,
  })
  const instance = Bun.serve({ port: envs.MANAGEMENT_PORT, fetch: managementApp.fetch, idleTimeout: 60 })
  logger.info({ port: instance.port }, 'Management API listening')
  return instance
}

// Module-scope so the SIGINT/SIGTERM handlers below can stop it too.
const managementServer = startManagementServer()

// Auto-register as a Torznab indexer + qBittorrent download client in each
// destination that opts in via its `autoregister` config. We register even when
// there are no peers / an empty catalog (forceSave on the *arr side), so the
// Jack indexer and client are always present and bound — they start returning
// results as soon as peers come online.
const managedApiKeys = new ManagedApiKeys(managedKeysRepository)
const jackConfig = config.jack
const downloads = config.downloads

if (!downloads) {
  logger.warn('No "downloads" config set; skipping download client auto-registration. Grabs will fail until a qBittorrent client is configured.')
}

const registrable = connectorManager.destinations.filter(d => d.isInitialized && d.autoRegister.enable)
for (const dest of registrable) {
  await registerManagedForDestination(dest, {
    managedKeys: managedApiKeys,
    internalUrl: jackConfig.internalUrl,
    downloads: Boolean(downloads),
    category: qbCategoryForServer(dest.id),
    onSuccess: (kind, name, meta) => {
      if (kind === 'download client') {
        logger.info({ destination: name, downloadClientId: meta.downloadClientId }, 'Registered Jack as qBittorrent download client')
        return
      }
      logger.info({ destination: name, categories: meta.categories, downloadClientId: meta.downloadClientId }, 'Registered Jack as Torznab indexer')
    },
    onFailure: logRegistrationFailure,
  })
}
// Drop managed keys for destinations no longer registrable so stale keys can't authenticate.
managedApiKeys.prune(registrable.map(d => d.id))

importWatcher?.start()
if (downloadsConfig)
  failedDownloadReaper?.start(downloadsConfig.importPollIntervalMs)

// Re-drive interrupted downloads from a prior run.
if (config.downloads && downloadsService) {
  // Active re-enqueue: resume stale `downloading` rows in place, picking up from
  // their .part files.
  const resumed = await downloadsService.resumeStaleDownloads()
  if (resumed > 0)
    logger.warn({ downloads: resumed, databasePath: database.path }, 'Re-enqueued interrupted downloads from previous Jack run')
}
else {
  // No downloads config means stale rows cannot be resumed — mark them failed.
  const failed = await downloadsRepository.reconcileStaleDownloads()
  if (failed > 0)
    logger.warn({ downloads: failed, databasePath: database.path }, 'Marked stale downloads failed (no downloads config to resume them)')
}

process.on('SIGINT', async () => {
  logger.info('SIGINT received, exiting')
  importWatcher?.stop()
  failedDownloadReaper?.stop()
  catalogSync.stop()
  database.close()
  server.stop()
  managementServer?.stop()
  await shutdownTelemetry()
  process.exit(0)
})

process.on('SIGTERM', async () => {
  logger.info('SIGTERM received, exiting')
  importWatcher?.stop()
  failedDownloadReaper?.stop()
  catalogSync.stop()
  database.close()
  server.stop()
  managementServer?.stop()
  await shutdownTelemetry()
  process.exit(0)
})
