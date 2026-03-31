import type { JellyfinServerConnector } from '../../lib/servers/sources/jellyfin'
import type { AppConfig } from '../../lib/config'
import { logger } from '../../logger'

export class PeerController {
  constructor(
    private readonly jellyfin: JellyfinServerConnector,
    private readonly jackConfig: NonNullable<AppConfig['jack']>,
  ) {}

  async search(params: { q?: string, imdbId?: string, tvdbId?: string, season?: number, episode?: number }) {
    if (params.imdbId) {
      return this.jellyfin.searchByImdbId(params.imdbId)
    }

    if (params.tvdbId) {
      return this.jellyfin.searchByTvdbId(params.tvdbId, params.season, params.episode)
    }

    return this.jellyfin.searchItems(params.q ?? '')
  }

  async getItem(itemId: string) {
    return this.jellyfin.getItemById(itemId)
  }

  async getFilePath(itemId: string): Promise<string | null> {
    const filePath = await this.jellyfin.getItemFilePath(itemId)
    if (!filePath) return null
    return filePath
  }

  resolveLocalPath(jellyfinPath: string): string {
    return jellyfinPath
  }

  async streamFile(itemId: string): Promise<{ stream: ReadableStream, size: number, filename: string } | null> {
    const filePath = await this.getFilePath(itemId)
    if (!filePath) return null

    const localPath = this.resolveLocalPath(filePath)
    const file = Bun.file(localPath)

    if (!await file.exists()) {
      logger.warn({ localPath, itemId }, 'File not found on disk')
      return null
    }

    const size = file.size
    const filename = localPath.split('/').pop() ?? 'unknown'

    return {
      stream: file.stream(),
      size,
      filename,
    }
  }
}
