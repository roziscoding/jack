import type { ArrServerConnector } from '../../lib/servers/arr/base'
import type { ServerConnector } from '../../lib/servers/base'
import type { PeerConnector } from '../../lib/servers/peer'

function stringifyConnector(c: ServerConnector) {
  return {
    id: c.id,
    name: c.name,
    url: c.url,
    type: c.type,
    initialized: c.isInitialized,
    initializationError: c.initializationError,
  }
}

function stringifyServer(c: ArrServerConnector) {
  return { ...stringifyConnector(c), source: c.canSource, destination: c.canDestination }
}

function stringifyPeer(c: PeerConnector) {
  return { ...stringifyConnector(c), version: c.peerVersion }
}

export class ConfigController {
  constructor(
    private readonly connectors: { servers: ArrServerConnector[], peers: PeerConnector[] },
  ) {}

  listConfig() {
    return {
      servers: this.connectors.servers.map(stringifyServer),
      peers: this.connectors.peers.map(stringifyPeer),
    }
  }

  listPeers() {
    return { peers: this.connectors.peers.map(stringifyPeer) }
  }

  listServers() {
    return { servers: this.connectors.servers.map(stringifyServer) }
  }
}
