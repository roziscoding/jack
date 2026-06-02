import type { Release } from '../../lib/release'
import type { ArrServerConnector } from '../../lib/servers/arr/base'
import { logger } from '../../logger'

/**
 * Serves the /peer API that other jacks talk to. Reads availability from the
 * local arr sources (the `source: true` Radarr/Sonarr servers) and streams the
 * underlying files from disk.
 */
export class PeerController {
  constructor(
    private readonly sources: ArrServerConnector[],
  ) {}

  // Sources gated by config only (`source: true`). We deliberately do NOT filter
  // by `isInitialized` here: a source that failed to connect at boot is still
  // attempted and re-initialized lazily by @requireInitialization, so one that
  // came back online rejoins searches without a restart.
  private get sourceServers() {
    return this.sources.filter(s => s.canSource)
  }

  async search(params: { q?: string, imdbId?: string, tvdbId?: string, season?: number, episode?: number }): Promise<Release[]> {
    const sources = this.sourceServers
    logger.debug({ params, totalSources: this.sources.length, sourceServers: sources.length }, 'Peer search request received')

    if (sources.length === 0) {
      logger.warn({ params }, 'Peer search: no source-enabled servers — returning empty result')
      return []
    }

    // Each source is isolated: a failure (still down, or errors) is logged and
    // treated as zero results, so one bad source doesn't fail the whole search.
    const results = await Promise.all(sources.map(async (source) => {
      try {
        const items = params.imdbId
          ? await source.searchByImdbId(params.imdbId)
          : params.tvdbId
            ? await source.searchByTvdbId(params.tvdbId, params.season, params.episode)
            : await source.searchItems(params.q ?? '')
        logger.debug({ source: source.name, type: source.type, params, count: items.length }, 'Source returned releases for peer search')
        return items
      }
      catch (err) {
        logger.error({ source: source.name, type: source.type, params, err }, 'Source search failed — skipping this source')
        return []
      }
    }))

    const flat = results.flat()
    logger.debug({ params, total: flat.length }, 'Peer search complete')
    return flat
  }

  async getItem(id: string): Promise<Release | null> {
    const source = this.findSource(id)
    if (!source)
      return null
    return source.getRelease(id)
  }

  // A release id is `${connectorId}:${kind}:${entityId}`; route it to the arr
  // source that produced it.
  private findSource(id: string): ArrServerConnector | undefined {
    const connectorId = id.split(':')[0]
    return this.sourceServers.find(s => s.id === connectorId)
  }

  async streamFile(id: string): Promise<{ stream: ReadableStream, size: number, filename: string } | null> {
    const source = this.findSource(id)
    if (!source)
      return null

    const filePath = await source.getFilePath(id)
    if (!filePath)
      return null

    const file = Bun.file(filePath)
    if (!await file.exists()) {
      logger.warn({ filePath, id }, 'File not found on disk')
      return null
    }

    return {
      stream: file.stream(),
      size: file.size,
      filename: filePath.split('/').pop() ?? 'unknown',
    }
  }
}
