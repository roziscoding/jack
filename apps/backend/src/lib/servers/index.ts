import type { AppConfig } from '../config'
import type { ServerConnector } from './base'
import { logger } from '../../logger'
import { getDestinationConnectors } from './destinations'
import { getSourceConnectors } from './sources'

export function getConnectors(servers: AppConfig['servers']) {
  return {
    sources: getSourceConnectors(servers),
    destinations: getDestinationConnectors(servers),

  }
}

export async function initializeConnectors(servers: AppConfig['servers']) {
  const connectors = getConnectors(servers)
  const connectorCount = connectors.sources.length + connectors.destinations.length
  logger.debug(`Found ${connectorCount} connectors. Initializing...`)

  const allConnectors = [...connectors.sources, ...connectors.destinations]

  await Promise.all(
    allConnectors.map(async (connector) => {
      logger.info({ connector: { name: connector.name, url: connector.url } }, `Initializing connector ${connector.name}`)
      connector.init()
      await connector.initialization!
        .then(() => {
          logger.debug({ connector: { name: connector.name, url: connector.url } }, `Initialized connector ${connector.name}`)
        })!
        .catch((error) => {
          const message = error instanceof Error ? error.message : String(error)
          logger.error({ error, connector: { name: connector.name, url: connector.url } }, `Failed to initialize connector ${connector.name}: ${message}`)
        })
    }),
  )

  return connectors
}
