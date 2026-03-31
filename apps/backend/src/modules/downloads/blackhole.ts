import { watch } from 'node:fs'
import { readdir, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import type { JackServerConnector } from '../../lib/servers/sources/jack'
import type { DestinationServerConnector } from '../../lib/servers/destinations/base'
import type { AppConfig } from '../../lib/config'
import { parseTorrentStub } from '../torznab/torrent'
import { logger } from '../../logger'

const STABILITY_DELAY_MS = 500
const STABILITY_RETRIES = 3

export class BlackholeWatcher {
  private watcher: ReturnType<typeof watch> | null = null
  private processing = new Set<string>()

  constructor(
    private readonly config: NonNullable<AppConfig['downloads']>,
    private readonly peers: JackServerConnector[],
    private readonly destinations: DestinationServerConnector[],
  ) {}

  async start() {
    const { watchPath, completedPath } = this.config

    await Bun.$`mkdir -p ${watchPath} ${completedPath}`.quiet()

    // Process any existing .torrent files
    await this.scanExisting()

    this.watcher = watch(watchPath, async (_event, filename) => {
      if (!filename?.endsWith('.torrent')) return

      const filePath = join(watchPath, filename)
      if (!await this.waitForStableFile(filePath)) return
      await this.processTorrent(filePath, filename)
    })

    logger.info({ watchPath, completedPath }, 'Blackhole watcher started')
  }

  stop() {
    this.watcher?.close()
    this.watcher = null
    logger.info('Blackhole watcher stopped')
  }

  private async waitForStableFile(filePath: string): Promise<boolean> {
    let lastSize = -1
    for (let i = 0; i < STABILITY_RETRIES; i++) {
      await Bun.sleep(STABILITY_DELAY_MS)
      const file = Bun.file(filePath)
      if (!await file.exists()) return false
      const size = file.size
      if (size === lastSize && size > 0) return true
      lastSize = size
    }
    return lastSize > 0
  }

  private async scanExisting() {
    try {
      const files = await readdir(this.config.watchPath)
      for (const file of files) {
        if (file.endsWith('.torrent')) {
          await this.processTorrent(join(this.config.watchPath, file), file)
        }
      }
    } catch {
      // Directory might not exist yet
    }
  }

  private async processTorrent(filePath: string, filename: string) {
    if (this.processing.has(filename)) return
    this.processing.add(filename)

    try {
      const file = Bun.file(filePath)
      if (!await file.exists()) return

      const data = Buffer.from(await file.arrayBuffer())
      const stub = parseTorrentStub(data)

      if (!stub) {
        logger.warn({ filename }, 'Could not parse torrent stub, skipping')
        return
      }

      const { peerId, itemId } = stub
      const peer = this.peers.find(p => p.id === peerId && p.isInitialized)

      if (!peer) {
        logger.error({ peerId, filename }, 'Peer not found or not initialized')
        return
      }

      logger.info({ peerId, itemId, peer: peer.name ?? peer.url }, 'Downloading from peer')

      const item = await peer.getItemMetadata(itemId)
      const itemName = item.Name ?? 'Unknown'
      const ext = item.MediaSources?.[0]?.Path?.split('.').pop() ?? 'mkv'
      const destFilename = `${itemName}.${ext}`
      const destPath = join(this.config.completedPath, destFilename)

      await peer.downloadFile(itemId, destPath)

      // Remove the .torrent stub
      await unlink(filePath)

      // Trigger import scan on all destinations
      await this.triggerImport()

      logger.info({ itemName, destPath }, 'Download complete, triggered import')
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      logger.error({ filename, error: message }, 'Failed to process torrent')
    } finally {
      this.processing.delete(filename)
    }
  }

  private async triggerImport() {
    for (const dest of this.destinations.filter(d => d.isInitialized)) {
      try {
        await dest.triggerImport(this.config.completedPath)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        logger.error({ destination: dest.name, error: message }, 'Failed to trigger import')
      }
    }
  }
}
