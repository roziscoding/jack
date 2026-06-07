import type { ArrServerConnector } from '../../lib/servers/arr/base'
import type { ServerConnector } from '../../lib/servers/base'
import type { PeerConnector } from '../../lib/servers/peer'
import { SonarrServerConnector } from '../../lib/servers/arr/sonarr'

function stringifyConnector(c: ServerConnector) {
  return {
    name: c.name,
    url: c.url,
    type: c.type,
    initialized: c.isInitialized,
    initializationError: c.initializationError,
  }
}

function stringifyServer(c: ArrServerConnector) {
  return {
    ...stringifyConnector(c),
    source: c.canSource,
    destination: c.canDestination,
  }
}

function stringifyPeer(c: PeerConnector) {
  return {
    ...stringifyConnector(c),
    version: c.peerVersion,
  }
}

export class ServersController {
  constructor(
    private readonly connectors: { servers: ArrServerConnector[], peers: PeerConnector[] },
  ) {}

  async getIssues(serverUrl?: string) {
    const sonarrConnectors = this.connectors.servers
      .filter(c => c instanceof SonarrServerConnector && c.canDestination)
      .filter(c => !serverUrl || c.url === serverUrl)

    if (sonarrConnectors.length === 0) {
      return { issues: [] }
    }

    const issuePromises = sonarrConnectors.map(async (c) => {
      const issues = await c.getHealthIssues()
      return {
        name: c.name,
        issues,
      }
    })

    const issues = await Promise.all(issuePromises)

    return { issues }
  }

  listServers() {
    return {
      servers: this.connectors.servers.map(stringifyServer),
      peers: this.connectors.peers.map(stringifyPeer),
    }
  }
}
