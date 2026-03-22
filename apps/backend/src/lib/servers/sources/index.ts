import type { AppConfig, SourceServerType } from '../../config'
import { JellyfinServerConnector } from './jellyfin'

const connectorMap = {
  jellyfin: JellyfinServerConnector,
} as const

export function getConnector(config: { type: SourceServerType, url: string, apiKey: string, name?: string }) {
  const Connector = connectorMap[config.type]

  if (!Connector) {
    return null
  }

  return new Connector(config)
}

export function getSourceConnectors(servers: AppConfig['servers']) {
  return servers.sources.map(getConnector).filter(Boolean)
}
