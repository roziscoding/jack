import type { AppConfig } from '../../lib/config'
import type { DownloadsService } from './downloads.service'
import { watch } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { logger } from '../../logger'

const STABILITY_DELAY_MS = 500
const STABILITY_RETRIES = 3

export class BlackholeWatcher {
  private watcher: ReturnType<typeof watch> | null = null
  private processing = new Set<string>()

  constructor(
    private readonly config: NonNullable<AppConfig['downloads']>,
    private readonly downloadsService: DownloadsService,
  ) {}

  async start() {
    const { watchPath, completedPath } = this.config

    await Bun.$`mkdir -p ${watchPath} ${completedPath}`.quiet()

    // Register the watcher BEFORE scanning so a .torrent dropped during the
    // scan is not missed. The `processing` Set dedupes a file caught by both
    // the watch event and the scan.
    this.watcher = watch(watchPath, async (_event, filename) => {
      if (!filename)
        return

      const torrentFilename = String(filename)
      if (!torrentFilename.endsWith('.torrent'))
        return

      const filePath = join(watchPath, torrentFilename)
      logger.debug({ torrentFilename, filePath, watchPath }, 'Torrent file detected in watch folder')
      if (!await this.waitForStableFile(filePath))
        return
      await this.processTorrentFile(filePath, torrentFilename)
    })

    await this.scanExisting()

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
        await this.processTorrentFile(filePath, file)
      }
    }
    catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      logger.warn({ watchPath: this.config.watchPath, error: message }, 'Watch folder scan failed')
    }
  }

  private async processTorrentFile(filePath: string, filename: string) {
    if (this.processing.has(filename))
      return
    this.processing.add(filename)

    try {
      await this.downloadsService.processTorrentFile(filePath, filename)
    }
    finally {
      this.processing.delete(filename)
    }
  }
}
