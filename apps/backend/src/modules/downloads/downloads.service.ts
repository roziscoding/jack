import type { AppConfig } from '../../lib/config'
import type { ArrServerConnector } from '../../lib/servers/arr/base'
import type { PeerConnector, PeerDownloadProgressEvent } from '../../lib/servers/peer'
import type { DownloadsRepository } from './downloads.repository'
import { Buffer } from 'node:buffer'
import { unlink } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { withSpan } from '../../lib/tracing'
import { logger } from '../../logger'
import { parseTorrentStub } from '../torznab/torrent'

export class DownloadsService {
  constructor(
    private readonly config: Pick<NonNullable<AppConfig['downloads']>, 'completedPath'>,
    private readonly peers: PeerConnector[],
    private readonly destinations: ArrServerConnector[],
    private readonly downloadsRepository?: DownloadsRepository,
  ) {}

  async processTorrentFile(filePath: string, filename: string) {
    try {
      await withSpan('blackhole.process_torrent', { 'torrent.filename': filename }, async (span) => {
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
        span.setAttributes({ 'peer.id': peerId, 'item.id': itemId })

        const peer = this.peers.find(p => p.id === peerId)
        if (!peer) {
          span.setAttribute('peer.found', false)
          logger.error({ torrentFilename: filename, peerId, filename }, 'Peer not found')
          return
        }

        span.setAttributes({ 'peer.found': true, 'peer.name': peer.name ?? peer.url })

        const release = await peer.getRelease(itemId)

        // `release.filename` is peer-controlled and only validated as a string.
        // Force it to a plain basename inside `completedPath` so a value like
        // `../../evil.mkv` or an absolute path cannot escape the directory.
        // Reject (rather than silently rewrite) anything that is not already a
        // plain filename, so a malicious peer cannot smuggle in path separators.
        const safeName = basename(release.filename)
        const isSafeName = safeName.length > 0 && safeName !== '.' && safeName !== '..'
          && !safeName.includes('/') && !safeName.includes('\\')
          && release.filename === safeName

        if (!isSafeName)
          throw new Error(`Unsafe release filename from peer: ${release.filename}`)

        const destPath = join(this.config.completedPath, safeName)
        const partPath = `${destPath}.part`
        span.setAttributes({ 'release.filename': safeName, 'release.size': release.size })

        const download = this.downloadsRepository?.create({
          torrentFilename: filename,
          peerId,
          peerName: peer.name ?? peer.url,
          itemId,
          filename: safeName,
          destPath,
          partPath,
          releaseSize: release.size,
          release,
        })

        const onProgress = async (event: PeerDownloadProgressEvent) => {
          if (!download)
            return

          if (event.type === 'headers') {
            this.downloadsRepository?.setExpectedBytes(download.id, event.expectedBytes, event.expectedBytesSource, event.expectedBytesMismatch)
            return
          }

          if (event.type === 'progress') {
            this.downloadsRepository?.updateProgress(download.id, event.downloadedBytes)
            return
          }

          this.downloadsRepository?.markCompleted(download.id, event.downloadedBytes)
        }

        // Everything after the row is created is wrapped so any failure
        // (download, stub unlink, or import trigger) marks the row failed
        // instead of leaving it stuck in `completed`/`downloading`.
        // `import_queued` means: the file downloaded AND triggerImport was
        // attempted (best-effort per destination — see triggerImport below).
        try {
          await peer.downloadFile(itemId, destPath, { torrentFilename: filename, partPath, releaseSize: release.size, onProgress })
          await unlink(filePath)
          await this.triggerImport(filename)

          if (download)
            this.downloadsRepository?.markImportQueued(download.id)
        }
        catch (err) {
          if (download) {
            const message = err instanceof Error ? err.message : String(err)
            this.downloadsRepository?.markFailed(download.id, message)
          }
          throw err
        }

        logger.info({ torrentFilename: filename, filename: safeName }, 'Download complete, triggered import')
      })
    }
    catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      logger.error({ torrentFilename: filename, filename, error: message }, 'Failed to process torrent')
    }
  }

  private async triggerImport(torrentFilename: string) {
    for (const dest of this.destinations.filter(d => d.isInitialized && d.canDestination)) {
      try {
        await withSpan('blackhole.trigger_import', { 'torrent.filename': torrentFilename, 'destination.name': dest.name }, async () => {
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
