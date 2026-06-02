import type { AppConfig, ServerConfig } from '../config'
import type { ArrServerConnector } from './arr/base'
import type { ServerConnector } from './base'
import { logger } from '../../logger'
import { RadarrServerConnector } from './arr/radarr'
import { SonarrServerConnector } from './arr/sonarr'
import { PeerConnector } from './peer'

const serverConnectorMap = {
  radarr: RadarrServerConnector,
  sonarr: SonarrServerConnector,
} as const

export function getServerConnector(config: ServerConfig): ArrServerConnector {
  const Connector = serverConnectorMap[config.type]
  return new Connector(config)
}

export function getConnectors(config: Pick<AppConfig, 'servers' | 'peers'>) {
  const servers = config.servers.map(getServerConnector)
  const peers = config.peers.map(peer => new PeerConnector(peer))
  return { servers, peers }
}

export async function initializeConnectors(config: Pick<AppConfig, 'servers' | 'peers'>) {
  const connectors = getConnectors(config)
  const allConnectors: ServerConnector[] = [...connectors.servers, ...connectors.peers]
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
