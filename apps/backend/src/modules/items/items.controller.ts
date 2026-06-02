import type { ArrServerConnector } from '../../lib/servers/arr/base'

export class ItemsController {
  constructor(
    private readonly connectors: { sources: ArrServerConnector[] },
  ) {}

  async searchItems(searchTerm: string) {
    const sources = this.connectors.sources.filter(c => c.isInitialized && c.canSource)
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
