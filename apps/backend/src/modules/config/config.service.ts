import type { z } from 'zod'
import type { AppConfig } from '../../lib/config'
import type { ConnectorManager } from '../../lib/servers'
import type { DownloadsRepository } from '../downloads/downloads.repository'
import { jsonc } from 'jsonc'
import { atomicWriteFile } from '../../lib/atomic-write'
import { PeerConfig, RawPeerConfig } from '../../lib/config'
import { ConflictError } from '../../lib/errors/ConflictError'
import { NotFoundError } from '../../lib/errors/NotFoundError'
import { generateId } from '../../lib/servers/base'

type RawConfig = z.input<typeof AppConfig>
type RawPeer = RawPeerConfig

export class ConfigService {
  #path: string
  #raw: RawConfig
  #connectorManager: ConnectorManager
  #downloadsRepository?: DownloadsRepository
  // Serialized write queue: one async mutex every mutation chains onto, so file
  // read-modify-write + map mutation never interleave between concurrent calls.
  #queue: Promise<unknown> = Promise.resolve()

  constructor(params: { path: string, raw: RawConfig, connectorManager: ConnectorManager, downloadsRepository?: DownloadsRepository }) {
    this.#path = params.path
    this.#raw = params.raw
    this.#connectorManager = params.connectorManager
    this.#downloadsRepository = params.downloadsRepository
  }

  /** Load the raw (refs-intact) config object from disk to seed the service. */
  static async fromFile(params: { path: string, connectorManager: ConnectorManager, downloadsRepository?: DownloadsRepository }): Promise<ConfigService> {
    const text = await Bun.file(params.path).text()
    const raw = jsonc.parse(text) as RawConfig
    return new ConfigService({ path: params.path, raw, connectorManager: params.connectorManager, downloadsRepository: params.downloadsRepository })
  }

  #enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(task, task)
    // Swallow this task's result/error on the chain so a rejection doesn't poison
    // the next enqueued task; the original promise still rejects to the caller.
    this.#queue = run.then(() => {}, () => {})
    return run
  }

  // Rollback-safe persist: write the CANDIDATE raw to disk first; the caller only
  // assigns `this.#raw = next` AFTER this resolves, so a failed write never leaves
  // in-memory state diverged from the file.
  async #persist(next: RawConfig): Promise<void> {
    await atomicWriteFile(this.#path, jsonc.stringify(next, { space: 2 }))
  }

  async addPeer(input: unknown): Promise<void> {
    // Validate + resolve secrets up front: a bad shape or unresolvable {env}/{file}
    // ref throws (→ 400) BEFORE any file/map mutation. We persist the ORIGINAL
    // input (refs intact), not the resolved value.
    const resolved = PeerConfig.parse(input)
    // RawPeerConfig.parse strips unknown keys but preserves {env}/{file} refs — this
    // sanitized object (not the raw `input`) is what we persist.
    const rawPeer = RawPeerConfig.parse(input)

    return this.#enqueue(async () => {
      const peers = (this.#raw.peers ?? []) as RawPeer[]

      if (peers.some(p => p.url === resolved.url))
        throw new ConflictError(`A peer with url "${resolved.url}" already exists`)
      if (peers.some(p => p.name === resolved.name))
        throw new ConflictError(`A peer named "${resolved.name}" already exists`)

      // Build the candidate, persist it, THEN commit in-memory + reconcile the map.
      const next: RawConfig = { ...this.#raw, peers: [...peers, rawPeer] }
      await this.#persist(next)
      this.#raw = next
      await this.#connectorManager.addPeerConnector(resolved)
    })
  }

  #findPeerIndexById(peers: RawPeer[], id: string): number {
    return peers.findIndex(p => generateId(p.url) === id)
  }

  async removePeer(id: string): Promise<void> {
    return this.#enqueue(async () => {
      const peers = (this.#raw.peers ?? []) as RawPeer[]
      const index = this.#findPeerIndexById(peers, id)
      if (index === -1)
        throw new NotFoundError(`No peer found with id "${id}"`)

      // File is the source of truth: persist the file WITHOUT the peer first, commit
      // in-memory, then disable the live connector. It stays resident (disabled) so
      // in-flight downloads holding its reference finish; new fan-outs skip it;
      // restart prunes it.
      const next: RawConfig = { ...this.#raw, peers: peers.filter((_, i) => i !== index) }
      await this.#persist(next)
      this.#raw = next
      this.#connectorManager.removeConnector(id)
    })
  }

  async updatePeer(id: string, input: unknown): Promise<void> {
    const resolved = PeerConfig.parse(input)
    const rawPeer = RawPeerConfig.parse(input) // strip unknown keys, keep refs
    const newId = generateId(resolved.url)

    return this.#enqueue(async () => {
      const peers = (this.#raw.peers ?? []) as RawPeer[]
      const index = this.#findPeerIndexById(peers, id)
      if (index === -1)
        throw new NotFoundError(`No peer found with id "${id}"`)

      // Name must stay unique against every OTHER peer.
      if (peers.some((p, i) => i !== index && p.name === resolved.name))
        throw new ConflictError(`A peer named "${resolved.name}" already exists`)

      const next: RawConfig = { ...this.#raw, peers: peers.map((p, i) => (i === index ? rawPeer : p)) }

      if (newId === id) {
        // Same url → rename / re-key headers. addPeerConnector overwrites the map
        // entry and re-inits; the old instance is dropped, any in-flight download
        // holding it finishes.
        await this.#persist(next)
        this.#raw = next
        await this.#connectorManager.addPeerConnector(resolved)
        return
      }

      // URL changed → the id moves. Reject collision with an existing peer's url.
      if (peers.some((p, i) => i !== index && generateId(p.url) === newId))
        throw new ConflictError(`A peer with url "${resolved.url}" already exists`)

      await this.#persist(next)
      this.#raw = next
      // Add under the new id (init on the new url), then drain the old connector and
      // cascade the download rows so they follow the peer to the new id.
      await this.#connectorManager.addPeerConnector(resolved)
      this.#connectorManager.removeConnector(id)
      this.#downloadsRepository?.reassignPeerId(id, newId)
    })
  }
}
