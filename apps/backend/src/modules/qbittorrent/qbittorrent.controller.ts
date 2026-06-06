import type { ArrServerConnector } from '../../lib/servers/arr/base'
import type { DownloadRecord, DownloadsRepository } from '../downloads/downloads.repository'
import type { QbTorrent } from './qbittorrent.mapper'
import { deriveHash, qbCategoryForServer, toQbTorrent } from './qbittorrent.mapper'
import { QbSessionStore } from './qbittorrent.session'

export interface QbittorrentControllerDeps {
  apiKey: string
  completedPath: string
  servers: ArrServerConnector[]
  repository: DownloadsRepository
}

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
}
