import type { ServerConnector } from '../../lib/servers/base'
import { SonarrServerConnector } from '../../lib/servers/destinations/sonarr'

function stringityConnector(c: ServerConnector) {
  return {
    name: c.name,
    url: c.url,
    type: c.type,
    initialized: c.isInitialized,
    initializationError: c.initializationError,
  }
}

export class ServersController {
  constructor(
    private readonly connectors: { sources: ServerConnector[], destinations: ServerConnector[] },
  ) {}

  async getIssues(serverUrl?: string) {
    const sonarrConnectors = this.connectors.destinations.filter(c => c instanceof SonarrServerConnector).filter(c => !serverUrl || c.url === serverUrl)
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
      servers: {
        source: this.connectors.sources.map(stringityConnector),
        destination: this.connectors.destinations.map(stringityConnector),
      },
    }
  }
}
