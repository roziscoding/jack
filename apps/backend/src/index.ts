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
import { ConfigService } from './modules/config/config.service'
import { DownloadsRepository } from './modules/downloads/downloads.repository'
import { DownloadsService } from './modules/downloads/downloads.service'
import { ImportWatcher } from './modules/downloads/import-watcher'
import { ManagedKeysRepository } from './modules/managed-keys/managed-keys.repository'
import { ManagedApiKeys } from './modules/managed-keys/managed-keys.service'
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
const { appConfig: config, raw: rawConfig } = await getAppConfig(envs)

const connectorManager = new ConnectorManager(config.servers, config.peers)
await connectorManager.initAll()

const database = await openDatabase({ appConfigPath: envs.APP_CONFIG_PATH })
const downloadsRepository = new DownloadsRepository(database.db)
const apiKeysRepository = new ApiKeysRepository(database.db)
const managedKeysRepository = new ManagedKeysRepository(database.db)

// Seed the management service from the shared raw object returned by getAppConfig
// so the service's persisted state can never diverge from the loaded runtime config.
const configService = envs.MANAGEMENT_KEY
  ? new ConfigService({ path: envs.APP_CONFIG_PATH, raw: rawConfig, connectorManager, downloadsRepository })
  : undefined

const downloadsService = config.downloads
  ? new DownloadsService(config.downloads, connectorManager, downloadsRepository)
  : undefined

const app = getApp(envs, config, connectorManager, { downloadsRepository, downloadsService, apiKeysRepository, managedKeysRepository })
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
    apiKeysRepository,
    tmdbApiKey: config.jack.tmdbApiKey,
  })
  const instance = Bun.serve({ port: envs.MANAGEMENT_PORT, fetch: managementApp.fetch })
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

// Detect *arr imports of finished downloads and flip them import_queued → imported.
const importWatcher = config.downloads
  ? new ImportWatcher(downloadsRepository, connectorManager, config.downloads.importPollIntervalMs)
  : undefined
importWatcher?.start()

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
  database.close()
  server.stop()
  managementServer?.stop()
  await shutdownTelemetry()
  process.exit(0)
})

process.on('SIGTERM', async () => {
  logger.info('SIGTERM received, exiting')
  importWatcher?.stop()
  database.close()
  server.stop()
  managementServer?.stop()
  await shutdownTelemetry()
  process.exit(0)
})
