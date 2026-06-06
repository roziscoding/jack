import type { ArrServerConnector } from '../../lib/servers/arr/base'
import type { DownloadRecord, DownloadsRepository } from '../downloads/downloads.repository'
import type { DownloadsService } from '../downloads/downloads.service'
import type { QbTorrent } from './qbittorrent.mapper'
import type { QbSession } from './qbittorrent.session'
import { Buffer } from 'node:buffer'
import { unlink } from 'node:fs/promises'
import { parseTorrentStub } from '../torznab/torrent'
import { deriveHash, qbCategoryForServer, toQbTorrent } from './qbittorrent.mapper'
import { QbSessionStore } from './qbittorrent.session'

export interface QbittorrentControllerDeps {
  apiKey: string
  completedPath: string
  servers: ArrServerConnector[]
  repository: DownloadsRepository
  downloadsService?: DownloadsService
}

// Matches a jack download URL path: /torznab/download/<peerId:itemId>.torrent
const JACK_DOWNLOAD_PATH = /\/torznab\/download\/(.+)\.torrent$/

export class QbittorrentController {
  readonly sessions = new QbSessionStore()

  constructor(private readonly deps: QbittorrentControllerDeps) {}

  /**
   * New SID on success; null on unknown username or wrong password. Username
   * must match a configured server connector name; password must equal jack's
   * apiKey (skipped when apiKey is empty, i.e. jack auth disabled).
   */
  login(username: string, password: string): string | null {
    const { apiKey, servers } = this.deps
    const server = servers.find(s => s.name === username)
    if (!server)
      return null
    if (apiKey !== '' && password !== apiKey)
      return null
    return this.sessions.create({ serverName: server.name, serverId: server.id })
  }

  logout(sid: string | undefined): void {
    this.sessions.delete(sid)
  }

  webapiVersion(): string {
    return '2.9.2' // >= 2.6.1 so *arr reads content_path; >= 2.0 selects the V2 proxy
  }

  version(): string {
    return 'v4.6.4'
  }

  preferences() {
    // Tuned so *arr's RemovesCompletedDownloads() is false (max_ratio_act=Pause,
    // ratio/seeding-time limits disabled) and its priority test is skipped.
    return {
      save_path: this.deps.completedPath,
      queueing_enabled: true,
      dht: true,
      max_ratio_enabled: false,
      max_ratio: -1,
      max_ratio_act: 0,
      max_seeding_time_enabled: false,
      max_seeding_time: -1,
    }
  }

  categories(): Record<string, { name: string, savePath: string }> {
    const out: Record<string, { name: string, savePath: string }> = {}
    for (const server of this.deps.servers) {
      const name = qbCategoryForServer(server.id)
      out[name] = { name, savePath: this.deps.completedPath }
    }
    return out
  }

  private findByHash(hash: string): DownloadRecord | null {
    const target = hash.toLowerCase()
    return this.deps.repository.list().find(r => deriveHash(r.release.title, r.releaseSize) === target) ?? null
  }

  /**
   * All rows sharing an infohash (the same release added by ≥1 server). Used by
   * the session-scoped mutations so a shared hash never touches another
   * server's row.
   */
  private findAllByHash(hash: string): DownloadRecord[] {
    const target = hash.toLowerCase()
    return this.deps.repository.list().filter(r => deriveHash(r.release.title, r.releaseSize) === target)
  }

  torrentsInfo(filter: { category?: string, hashes?: string[] }): QbTorrent[] {
    const { completedPath } = this.deps
    let result = this.deps.repository.list()
      .map(r => toQbTorrent(r, { completedPath, category: r.qbCategory ?? '' }))
    if (filter.category !== undefined)
      result = result.filter(t => t.category === filter.category)
    if (filter.hashes && filter.hashes.length > 0) {
      const set = new Set(filter.hashes.map(h => h.toLowerCase()))
      result = result.filter(t => set.has(t.hash))
    }
    return result
  }

  torrentProperties(hash: string): { save_path: string, seeding_time: number } | null {
    const record = this.findByHash(hash)
    if (!record)
      return null
    return { save_path: this.deps.completedPath, seeding_time: 0 }
  }

  torrentFiles(hash: string): { name: string }[] {
    const record = this.findByHash(hash)
    return record ? [{ name: record.filename }] : []
  }

  /**
   * Add result:
   * - 'ok' — accepted (jack stub upload or jack download URL).
   * - 'unsupported' (→ HTTP 415) — a magnet or a non-jack/foreign torrent.
   * - 'unavailable' (→ HTTP 503) — jack has no downloads config, so the add
   *   pipeline isn't wired; a server-side misconfiguration, not a bad torrent.
   */
  async addTorrent(input: { session: QbSession, category?: string, urls: string[], torrentFiles: Uint8Array[] }): Promise<'ok' | 'unsupported' | 'unavailable'> {
    const service = this.deps.downloadsService
    if (!service)
      return 'unavailable'

    const stubs: { peerId: string, itemId: string }[] = []
    for (const bytes of input.torrentFiles) {
      const stub = parseTorrentStub(Buffer.from(bytes))
      if (!stub)
        return 'unsupported'
      stubs.push(stub)
    }
    for (const url of input.urls) {
      const parsed = this.parseJackUrl(url)
      if (!parsed)
        return 'unsupported'
      stubs.push(parsed)
    }
    if (stubs.length === 0)
      return 'unsupported'

    const category = input.category && input.category.length > 0
      ? input.category
      : qbCategoryForServer(input.session.serverId)

    for (const stub of stubs) {
      await service.startQbDownload({
        peerId: stub.peerId,
        itemId: stub.itemId,
        qbCategory: category,
        qbSourceServer: input.session.serverName,
      })
    }
    return 'ok'
  }

  /**
   * Parse a jack download URL into peerId/itemId. Rejects magnets and any URL
   * that isn't a `/torznab/download/<peerId:itemId>.torrent` link.
   */
  private parseJackUrl(url: string): { peerId: string, itemId: string } | null {
    if (url.startsWith('magnet:'))
      return null
    let parsed: URL
    try {
      parsed = new URL(url)
    }
    catch {
      return null
    }
    const match = parsed.pathname.match(JACK_DOWNLOAD_PATH)
    if (!match || !match[1])
      return null
    const guid = decodeURIComponent(match[1])
    const [peerId, ...rest] = guid.split(':')
    const itemId = rest.join(':')
    if (!peerId || !itemId)
      return null
    return { peerId, itemId }
  }

  // Session-scoped: only ever touch rows added by the calling server. Because a
  // shared release yields the SAME infohash across servers, an unscoped delete
  // could remove another server's (or a blackhole) row.
  async deleteTorrents(session: QbSession, hashesParam: string, deleteFiles: boolean): Promise<void> {
    const mine = (r: DownloadRecord) => r.qbSourceServer === session.serverName
    const records = hashesParam === 'all'
      ? this.deps.repository.list().filter(mine)
      : hashesParam.split('|').flatMap(h => this.findAllByHash(h)).filter(mine)
    for (const record of records) {
      if (deleteFiles) {
        await unlink(record.destPath).catch(() => {})
        await unlink(record.partPath).catch(() => {})
      }
      this.deps.repository.delete(record.id)
    }
  }

  setCategory(session: QbSession, hashes: string[], category: string): void {
    for (const hash of hashes) {
      for (const record of this.findAllByHash(hash)) {
        if (record.qbSourceServer === session.serverName)
          this.deps.repository.setQbCategory(record.id, category)
      }
    }
  }
}
