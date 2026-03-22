import type { AppConfig, DestinationServerType } from '../../config'
import { RadarrServerConnector } from './radarr'
import { SonarrServerConnector } from './sonarr'

const connectorMap = {
  sonarr: SonarrServerConnector,
  radarr: RadarrServerConnector,
} as const

export function getConnector(config: { type: DestinationServerType, url: string, apiKey: string, name?: string }) {
  const Connector = connectorMap[config.type]

  if (!Connector) {
    return null
  }

  return new Connector(config)
}

export function getDestinationConnectors(servers: AppConfig['servers']) {
  return servers.destinations.map(getConnector).filter(Boolean)
}
