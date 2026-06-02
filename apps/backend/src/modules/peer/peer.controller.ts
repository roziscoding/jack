import type { ArrServerConnector } from '../../lib/servers/arr/base'
import type { Release } from '../../lib/release'
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

  private get activeSources() {
    return this.sources.filter(s => s.isInitialized && s.canSource)
  }

  async search(params: { q?: string, imdbId?: string, tvdbId?: string, season?: number, episode?: number }): Promise<Release[]> {
    const sources = this.activeSources
    if (sources.length === 0) return []

    const results = await Promise.all(sources.map((source) => {
      if (params.imdbId) return source.searchByImdbId(params.imdbId)
      if (params.tvdbId) return source.searchByTvdbId(params.tvdbId, params.season, params.episode)
      return source.searchItems(params.q ?? '')
    }))

    return results.flat()
  }

  async getItem(id: string): Promise<Release | null> {
    const source = this.findSource(id)
    if (!source) return null
    return source.getRelease(id)
  }

  // A release id is `${connectorId}:${kind}:${entityId}`; route it to the arr
  // source that produced it.
  private findSource(id: string): ArrServerConnector | undefined {
    const connectorId = id.split(':')[0]
    return this.activeSources.find(s => s.id === connectorId)
  }

  async streamFile(id: string): Promise<{ stream: ReadableStream, size: number, filename: string } | null> {
    const source = this.findSource(id)
    if (!source) return null

    const filePath = await source.getFilePath(id)
    if (!filePath) return null

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
