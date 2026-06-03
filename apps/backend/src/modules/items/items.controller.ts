import type { ArrServerConnector } from '../../lib/servers/arr/base'
import { logger } from '../../logger'

export class ItemsController {
  constructor(
    private readonly connectors: { sources: ArrServerConnector[] },
  ) {}

  async searchItems(searchTerm: string) {
    // Gated by config only (`source: true`); a source that's down is still tried
    // and re-initialized lazily by @requireInitialization, isolated per-source.
    const sources = this.connectors.sources.filter(c => c.canSource)
    logger.debug({ searchTerm, totalSources: this.connectors.sources.length, sourceServers: sources.length }, 'Items search request received')
    if (sources.length === 0) {
      logger.warn({ searchTerm }, 'Items search: no source-enabled servers — returning empty result')
      return []
    }

    const results = await Promise.all(sources.map(async (c) => {
      try {
        const items = await c.searchItems(searchTerm)
        logger.debug({ source: c.name, searchTerm, count: items.length }, 'Source returned items')
        return { name: c.name, items }
      }
      catch (err) {
        logger.error({ source: c.name, searchTerm, err }, 'Source search failed — skipping this source')
        return { name: c.name, items: [] }
      }
    }))

    return results
  }
}
