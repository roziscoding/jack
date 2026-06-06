import type { ArrServerConnector } from '../../lib/servers/arr/base'
import type { DownloadsRepository } from '../downloads/downloads.repository'
import { qbCategoryForServer } from './qbittorrent.mapper'
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

  // Phase 2 replaces the body with real download->torrent mapping.
  torrentsInfo(_filter: { category?: string, hashes?: string[] }): unknown[] {
    return []
  }
}
