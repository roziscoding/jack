import process from 'node:process'
import { getApp } from './app'
import { getAppConfig } from './lib/config'
import { getAppEnvs } from './lib/envs'
import { initializeConnectors } from './lib/servers'
import { BlackholeWatcher } from './modules/downloads/blackhole'
import { logger } from './logger'

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

// Auto-register as Torznab indexer in Radarr/Sonarr
if (config.jack && config.indexer?.autoRegister !== false) {
  const jackConfig = config.jack
  const indexerConfig = config.indexer ?? { priority: 1, autoRegister: true }

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
      const message = err instanceof Error ? err.message : String(err)
      logger.error({ destination: dest.name, error: message }, 'Failed to register indexer')
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
