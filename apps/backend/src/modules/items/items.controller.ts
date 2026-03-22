import type { SourceServerConnector } from '../../lib/servers/sources/base'

export class ItemsController {
  constructor(
    private readonly connectors: { sources: SourceServerConnector[] },
  ) {}

  async searchItems(searchTerm: string) {
    const sources = this.connectors.sources.filter(c => c.isInitialized)
    if (sources.length === 0) {
      return []
    }

    const results = await Promise.all(sources.map(async (c) => {
      const items = await c.searchItems(searchTerm)
      return {
        name: c.name,
        items,
      }
    }))

    return results
  }
}
