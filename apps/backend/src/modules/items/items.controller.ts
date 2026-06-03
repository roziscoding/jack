import type { ArrServerConnector } from '../../lib/servers/arr/base'
import { withSpan } from '../../lib/tracing'
import { logger } from '../../logger'

export class ItemsController {
  constructor(
    private readonly connectors: { sources: ArrServerConnector[] },
  ) {}

  async searchItems(searchTerm: string) {
    return withSpan('items.search', {
      'search.term': searchTerm,
      'source.total_count': this.connectors.sources.length,
      'source.enabled_count': this.connectors.sources.filter(c => c.canSource).length,
    }, async (span) => {
      // Gated by config only (`source: true`); a source that's down is still tried
      // and re-initialized lazily by @requireInitialization, isolated per-source.
      const sources = this.connectors.sources.filter(c => c.canSource)
      if (sources.length === 0) {
        span.setAttribute('source.result_count', 0)
        return []
      }

      const results = await Promise.all(sources.map(async (c) => {
        try {
          return await withSpan('items.source_search', {
            'source.name': c.name,
            'source.type': c.type,
            'search.term': searchTerm,
          }, async (sourceSpan) => {
            const items = await c.searchItems(searchTerm)
            sourceSpan.setAttribute('item.count', items.length)
            return { name: c.name, items }
          })
        }
        catch (err) {
          logger.error({ source: c.name, searchTerm, err }, 'Source search failed — skipping this source')
          return { name: c.name, items: [] }
        }
      }))

      span.setAttribute('source.result_count', results.length)
      return results
    })
  }
}
