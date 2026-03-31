import type { AppConfig } from '../config'
import type { ServerConnector } from './base'
import { logger } from '../../logger'
import { getDestinationConnectors } from './destinations'
import { getSourceConnectors } from './sources'

export function getConnectors(servers: AppConfig['servers']) {
  const { sources, peers } = getSourceConnectors(servers)
  const destinations = getDestinationConnectors(servers)
  return { sources, peers, destinations }
}

export async function initializeConnectors(servers: AppConfig['servers']) {
  const connectors = getConnectors(servers)
  const allConnectors: ServerConnector[] = [...connectors.sources, ...connectors.peers, ...connectors.destinations]
  logger.debug(`Found ${allConnectors.length} connectors. Initializing...`)

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
