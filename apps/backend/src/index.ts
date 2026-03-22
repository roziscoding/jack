import process from 'node:process'
import { getApp } from './app'
import { getAppConfig } from './lib/config'
import { getAppEnvs } from './lib/envs'
import { initializeConnectors } from './lib/servers'
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
  destinations: connectors.destinations.filter(c => c.isInitialized).length,
}, 'Server listening')

process.on('SIGINT', () => {
  logger.info('SIGINT received, exiting')
  server.stop()
  process.exit(0)
})

process.on('SIGTERM', () => {
  logger.info('SIGTERM received, exiting')
  server.stop()
  process.exit(0)
})
