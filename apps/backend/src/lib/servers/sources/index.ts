import type { AppConfig, SourceServerType } from '../../config'
import { JellyfinServerConnector } from './jellyfin'
import { JackServerConnector } from './jack'

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

export function getPeerConnectors(peers: NonNullable<AppConfig['servers']['peers']>) {
  return peers.map(config => new JackServerConnector(config))
}

export function getSourceConnectors(servers: AppConfig['servers']) {
  const sources = servers.sources.map(getConnector).filter(Boolean)
  const peers = getPeerConnectors(servers.peers ?? [])
  return { sources, peers }
}
