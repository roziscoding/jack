import type { ArrServerConnector } from '../../lib/servers/arr/base'
import { logger } from '../../logger'

export class ItemsController {
  constructor(
    private readonly connectors: { sources: ArrServerConnector[] },
  ) {}

  async searchItems(searchTerm: string) {
    const sources = this.connectors.sources.filter(c => c.isInitialized && c.canSource)
    logger.debug({ searchTerm, totalSources: this.connectors.sources.length, activeSources: sources.length }, 'Items search request received')
    if (sources.length === 0) {
      logger.warn({ searchTerm }, 'Items search: no active sources — returning empty result')
      return []
    }

    const results = await Promise.all(sources.map(async (c) => {
      const items = await c.searchItems(searchTerm)
      logger.debug({ source: c.name, searchTerm, count: items.length }, 'Source returned items')
      return {
        name: c.name,
        items,
      }
    }))

    return results
  }
}
