import type { AppConfig } from '../../lib/config'
import type { ArrServerConnector } from '../../lib/servers/arr/base'
import type { PeerConnector } from '../../lib/servers/peer'
import { Buffer } from 'node:buffer'
import { watch } from 'node:fs'
import { readdir, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { withSpan } from '../../lib/tracing'
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
      logger.debug({ torrentFilename: filename, filePath, watchPath }, 'Torrent file detected in watch folder')
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
    logger.debug({ watchPath: this.config.watchPath }, 'Starting watch folder scan')

    try {
      const files = await readdir(this.config.watchPath)
      const torrentFiles = files.filter(file => file.endsWith('.torrent'))

      logger.debug({ watchPath: this.config.watchPath, filesFound: torrentFiles.length }, 'Watch folder scan complete')

      for (const file of torrentFiles) {
        const filePath = join(this.config.watchPath, file)
        logger.debug({ torrentFilename: file, filePath, watchPath: this.config.watchPath }, 'Torrent file found in watch folder scan')
        await this.processTorrent(filePath, file)
      }
    }
    catch (err) {
      // Directory might not exist yet
      const message = err instanceof Error ? err.message : String(err)
      logger.warn({ watchPath: this.config.watchPath, error: message }, 'Watch folder scan failed')
    }
  }

  private async processTorrent(filePath: string, filename: string) {
    if (this.processing.has(filename))
      return
    this.processing.add(filename)

    try {
      await withSpan('blackhole.process_torrent', {
        'torrent.filename': filename,
      }, async (span) => {
        const file = Bun.file(filePath)
        if (!await file.exists()) {
          span.setAttribute('torrent.exists', false)
          return
        }

        span.setAttribute('torrent.exists', true)
        const data = Buffer.from(await file.arrayBuffer())
        const stub = parseTorrentStub(data)

        if (!stub) {
          span.setAttribute('torrent.stub.valid', false)
          logger.warn({ torrentFilename: filename, filename }, 'Could not parse torrent stub, skipping')
          return
        }

        span.setAttribute('torrent.stub.valid', true)
        const { peerId, itemId } = stub
        span.setAttributes({
          'peer.id': peerId,
          'item.id': itemId,
        })

        // No isInitialized pre-filter: the peer methods are guarded by
        // @requireInitialization, so a peer that was down at boot gets
        // re-initialized lazily on the getRelease/downloadFile calls below.
        const peer = this.peers.find(p => p.id === peerId)

        if (!peer) {
          span.setAttribute('peer.found', false)
          logger.error({ torrentFilename: filename, peerId, filename }, 'Peer not found')
          return
        }

        span.setAttributes({
          'peer.found': true,
          'peer.name': peer.name ?? peer.url,
        })

        const release = await peer.getRelease(itemId)
        const destPath = join(this.config.completedPath, release.filename)
        span.setAttributes({
          'release.filename': release.filename,
          'release.size': release.size,
        })

        await peer.downloadFile(itemId, destPath, { torrentFilename: filename })

        // Remove the .torrent stub
        await unlink(filePath)

        // Trigger import scan on all destinations
        await this.triggerImport(filename)

        logger.info({ torrentFilename: filename, filename: release.filename }, 'Download complete, triggered import')
      })
    }
    catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      logger.error({ torrentFilename: filename, filename, error: message }, 'Failed to process torrent')
    }
    finally {
      this.processing.delete(filename)
    }
  }

  private async triggerImport(torrentFilename: string) {
    for (const dest of this.destinations.filter(d => d.isInitialized && d.canDestination)) {
      try {
        await withSpan('blackhole.trigger_import', {
          'torrent.filename': torrentFilename,
          'destination.name': dest.name,
        }, async () => {
          await dest.triggerImport(this.config.completedPath)
        })
      }
      catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        logger.error({ torrentFilename, destination: dest.name, error: message }, 'Failed to trigger import')
      }
    }
  }
}
