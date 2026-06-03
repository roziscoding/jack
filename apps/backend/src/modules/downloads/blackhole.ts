import type { AppConfig } from '../../lib/config'
import type { ArrServerConnector } from '../../lib/servers/arr/base'
import type { PeerConnector } from '../../lib/servers/peer'
import { Buffer } from 'node:buffer'
import { watch } from 'node:fs'
import { readdir, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { logger } from '../../logger'
import { parseTorrentStub } from '../torznab/torrent'

const STABILITY_DELAY_MS = 500
const STABILITY_RETRIES = 3

export class BlackholeWatcher {
  private watcher: ReturnType<typeof watch> | null = null
  private processing = new Set<string>()

  constructor(
    private readonly config: NonNullable<AppConfig['downloads']>,
    private readonly peers: PeerConnector[],
    private readonly destinations: ArrServerConnector[],
  ) {}

  async start() {
    const { watchPath, completedPath } = this.config

    await Bun.$`mkdir -p ${watchPath} ${completedPath}`.quiet()

    // Process any existing .torrent files
    await this.scanExisting()

    this.watcher = watch(watchPath, async (_event, filename) => {
      if (!filename?.endsWith('.torrent'))
        return

      const filePath = join(watchPath, filename)
      if (!await this.waitForStableFile(filePath))
        return
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
      if (!await file.exists())
        return false
      const size = file.size
      if (size === lastSize && size > 0)
        return true
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
    }
    catch {
      // Directory might not exist yet
    }
  }

  private async processTorrent(filePath: string, filename: string) {
    if (this.processing.has(filename))
      return
    this.processing.add(filename)

    try {
      const file = Bun.file(filePath)
      if (!await file.exists())
        return

      const data = Buffer.from(await file.arrayBuffer())
      const stub = parseTorrentStub(data)

      if (!stub) {
        logger.warn({ filename }, 'Could not parse torrent stub, skipping')
        return
      }

      const { peerId, itemId } = stub
      // No isInitialized pre-filter: the peer methods are guarded by
      // @requireInitialization, so a peer that was down at boot gets
      // re-initialized lazily on the getRelease/downloadFile calls below.
      const peer = this.peers.find(p => p.id === peerId)

      if (!peer) {
        logger.error({ peerId, filename }, 'Peer not found')
        return
      }

      logger.info({ peerId, itemId, peer: peer.name ?? peer.url }, 'Downloading from peer')

      const release = await peer.getRelease(itemId)
      const destPath = join(this.config.completedPath, release.filename)

      await peer.downloadFile(itemId, destPath)

      // Remove the .torrent stub
      await unlink(filePath)

      // Trigger import scan on all destinations
      await this.triggerImport()

      logger.info({ filename: release.filename, destPath }, 'Download complete, triggered import')
    }
    catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      logger.error({ filename, error: message }, 'Failed to process torrent')
    }
    finally {
      this.processing.delete(filename)
    }
  }

  private async triggerImport() {
    for (const dest of this.destinations.filter(d => d.isInitialized && d.canDestination)) {
      try {
        await dest.triggerImport(this.config.completedPath)
      }
      catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        logger.error({ destination: dest.name, error: message }, 'Failed to trigger import')
      }
    }
  }
}
