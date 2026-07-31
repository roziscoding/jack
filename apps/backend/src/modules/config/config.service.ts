import type { z } from 'zod'
import type { AppConfig } from '../../lib/config'
import type { ConnectorManager } from '../../lib/servers'
import type { DownloadsRepository } from '../downloads/downloads.repository'
import { jsonc } from 'jsonc'
import { atomicWriteFile } from '../../lib/atomic-write'
import { JackConfig, PeerConfig, RawJackConfig, RawPeerConfig, RawServerConfig, ServerConfig } from '../../lib/config'
import { ConflictError } from '../../lib/errors/ConflictError'
import { NotFoundError } from '../../lib/errors/NotFoundError'
import { generateId } from '../../lib/servers/base'

type RawConfig = z.input<typeof AppConfig>
// Both peers and servers carry a plain-string `url` + `name` in their raw form —
// the only fields the generic add/remove/update helpers below need to reason about.
interface RawEntry { url: string, name: string }
type Slice = 'peers' | 'servers'

export class ConfigService {
  private path: string
  private raw: RawConfig
  private connectorManager: ConnectorManager
  private downloadsRepository?: DownloadsRepository
  // Serialized write queue: one async mutex every mutation chains onto, so file
  // read-modify-write + map mutation never interleave between concurrent calls.
  private queue: Promise<unknown> = Promise.resolve()
  private readonly subscribers = new Set<() => void>()

  constructor(params: { path: string, raw: RawConfig, connectorManager: ConnectorManager, downloadsRepository?: DownloadsRepository }) {
    this.path = params.path
    this.raw = params.raw
    this.connectorManager = params.connectorManager
    this.downloadsRepository = params.downloadsRepository
  }

  /**
   * Load the raw (refs-intact) config object from disk to seed the service.
   * Production wiring (`index.ts`) instead passes the already-parsed `raw` object
   * from `getAppConfig` to the constructor; this convenience factory is for
   * standalone / test construction from just a path.
   */
  static async fromFile(params: { path: string, connectorManager: ConnectorManager, downloadsRepository?: DownloadsRepository }): Promise<ConfigService> {
    const text = await Bun.file(params.path).text()
    const raw = jsonc.parse(text) as RawConfig
    return new ConfigService({ path: params.path, raw, connectorManager: params.connectorManager, downloadsRepository: params.downloadsRepository })
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task)
    const notified = run.finally(() => this.notifyChanged())
    // Swallow this task's result/error on the chain so a rejection doesn't poison
    // the next enqueued task; the original promise still rejects to the caller.
    this.queue = notified.then(() => {}, () => {})
    return notified
  }

  subscribe(subscriber: () => void): () => void {
    this.subscribers.add(subscriber)
    return () => this.subscribers.delete(subscriber)
  }

  private notifyChanged(): void {
    for (const subscriber of this.subscribers) {
      try {
        subscriber()
      }
      catch {
        // Observers must not affect config persistence or rollback semantics.
      }
    }
  }

  // Rollback-safe persist: write the CANDIDATE raw to disk first; the caller only
  // assigns `this.raw = next` AFTER this resolves, so a failed write never leaves
  // in-memory state diverged from the file.
  private async persist(next: RawConfig): Promise<void> {
    await atomicWriteFile(this.path, jsonc.stringify(next, { space: 2 }))
  }

  private slice(slice: Slice): RawEntry[] {
    return (this.raw[slice] ?? []) as RawEntry[]
  }

  /**
   * Persisted, refs-intact secret fields for a live connector, looked up by id.
   * Returns `apiKey`/`headers` exactly as stored — `{env}`/`{file}` refs are
   * preserved, never resolved — so the management UI can prefill an edit form
   * without the server ever resolving a secret into the response. Returns
   * `undefined` for an unknown id (e.g. a connector seeded outside the file).
   */
  getRawSecrets(kind: Slice, id: string): { apiKey: unknown, headers: Record<string, unknown> } | undefined {
    const entry = this.slice(kind).find(e => generateId(e.url) === id) as
      | (RawEntry & { apiKey?: unknown, headers?: Record<string, unknown> })
      | undefined
    if (!entry)
      return undefined
    return { apiKey: entry.apiKey, headers: entry.headers ?? {} }
  }

  /**
   * Persisted, refs-intact jack config for the management edit form, or null when
   * unset. Re-parsing through RawJackConfig keeps `{env}`/`{file}` refs unresolved
   * and drops an absent apiKey (no `apiKey` key) instead of emitting `undefined`.
   */
  getRawJack(): RawJackConfig | null {
    const jack = this.raw.jack
    if (!jack)
      return null
    return RawJackConfig.parse(jack)
  }

  private indexById(entries: RawEntry[], id: string): number {
    return entries.findIndex(e => generateId(e.url) === id)
  }

  // ── Generic CRUD over a config slice ─────────────────────────────────────────
  // Each helper runs inside the serialized queue and follows the same rollback-safe
  // order: build the candidate `next`, persist it, commit `this.raw`, then reconcile
  // the live connector map. `addConnector` instantiates the right connector type;
  // `onRekey` lets peers cascade their download rows on a URL change (servers pass none).

  private addEntry(slice: Slice, label: string, resolved: RawEntry, rawEntry: unknown, addConnector: () => Promise<void>): Promise<void> {
    return this.enqueue(async () => {
      const entries = this.slice(slice)
      if (entries.some(e => e.url === resolved.url))
        throw new ConflictError(`A ${label} with url "${resolved.url}" already exists`)
      if (entries.some(e => e.name === resolved.name))
        throw new ConflictError(`A ${label} named "${resolved.name}" already exists`)

      const previous = this.raw
      const next = { ...this.raw, [slice]: [...entries, rawEntry] } as RawConfig
      await this.persist(next)
      this.raw = next
      try {
        await addConnector()
      }
      catch (err) {
        // The connectivity check failed (interactive add). Roll the file + in-memory
        // config back so a peer that never connected isn't left half-added; the
        // connector evicts its own map entry (see ConnectorManager.addPeerConnector).
        await this.persist(previous)
        this.raw = previous
        throw err
      }
    })
  }

  private removeEntry(slice: Slice, label: string, id: string): Promise<void> {
    return this.enqueue(async () => {
      const entries = this.slice(slice)
      const index = this.indexById(entries, id)
      if (index === -1)
        throw new NotFoundError(`No ${label} found with id "${id}"`)

      // File is the source of truth: persist without the entry first, commit, then
      // disable the live connector. It stays resident (disabled) so in-flight
      // downloads holding its reference finish; new fan-outs skip it; restart prunes it.
      const next = { ...this.raw, [slice]: entries.filter((_, i) => i !== index) } as RawConfig
      await this.persist(next)
      this.raw = next
      this.connectorManager.removeConnector(id)
    })
  }

  private updateEntry(
    slice: Slice,
    label: string,
    id: string,
    resolved: RawEntry,
    rawEntry: unknown,
    addConnector: () => Promise<void>,
    onRekey?: (oldId: string, newId: string) => void,
  ): Promise<void> {
    const newId = generateId(resolved.url)
    return this.enqueue(async () => {
      const entries = this.slice(slice)
      const index = this.indexById(entries, id)
      if (index === -1)
        throw new NotFoundError(`No ${label} found with id "${id}"`)

      // Name must stay unique against every OTHER entry.
      if (entries.some((e, i) => i !== index && e.name === resolved.name))
        throw new ConflictError(`A ${label} named "${resolved.name}" already exists`)

      // A URL change re-derives the id; reject a collision with another entry's url
      // before touching the file.
      if (newId !== id && entries.some((e, i) => i !== index && generateId(e.url) === newId))
        throw new ConflictError(`A ${label} with url "${resolved.url}" already exists`)

      const previous = this.raw
      const next = { ...this.raw, [slice]: entries.map((e, i) => (i === index ? rawEntry : e)) } as RawConfig
      await this.persist(next)
      this.raw = next

      // Same url → addConnector overwrites the map entry under the stable id and
      // re-inits. URL change → it lands under the new id; then drain the old
      // connector and let peers cascade their download rows to the new id.
      try {
        await addConnector()
      }
      catch (err) {
        // The connectivity check failed (interactive update). Roll the file +
        // in-memory config back so the edit isn't half-applied; the connector restores
        // the live map to its prior state (see ConnectorManager.add*Connector).
        await this.persist(previous)
        this.raw = previous
        throw err
      }
      if (newId !== id) {
        this.connectorManager.removeConnector(id)
        onRekey?.(id, newId)
      }
    })
  }

  // ── Peers ────────────────────────────────────────────────────────────────────

  async addPeer(input: unknown, { force = false }: { force?: boolean } = {}): Promise<void> {
    // Validate + resolve secrets up front (bad shape / unresolvable ref → 400 before
    // any write); persist the ref-preserving `RawPeerConfig` parse, not the resolved value.
    const resolved = PeerConfig.parse(input)
    const rawPeer = RawPeerConfig.parse(input)
    // rethrowInitError: a peer that fails its handshake aborts the add (and rolls the
    // config back) so the UI can report the cause, rather than persisting a dead peer.
    // `force` flips this off: keep the peer even when it can't connect — it stays
    // resident and auto-retries lazily (init() is retry-aware).
    return this.addEntry('peers', 'peer', resolved, rawPeer, () => this.connectorManager.addPeerConnector(resolved, { rethrowInitError: !force }))
  }

  async removePeer(id: string): Promise<void> {
    return this.removeEntry('peers', 'peer', id)
  }

  async updatePeer(id: string, input: unknown, { force = false }: { force?: boolean } = {}): Promise<void> {
    const resolved = PeerConfig.parse(input)
    const rawPeer = RawPeerConfig.parse(input)
    return this.updateEntry(
      'peers',
      'peer',
      id,
      resolved,
      rawPeer,
      () => this.connectorManager.addPeerConnector(resolved, { rethrowInitError: !force }),
      (oldId, newId) => this.downloadsRepository?.reassignPeerId(oldId, newId),
    )
  }

  // ── Servers ──────────────────────────────────────────────────────────────────

  async addServer(input: unknown): Promise<void> {
    const resolved = ServerConfig.parse(input)
    const rawServer = RawServerConfig.parse(input)
    // rethrowInitError: a server that fails its status check aborts the add (and rolls
    // the config back) so the UI can report the cause, rather than persisting a dead one.
    return this.addEntry('servers', 'server', resolved, rawServer, () => this.connectorManager.addServerConnector(resolved, { rethrowInitError: true }))
  }

  async removeServer(id: string): Promise<void> {
    return this.removeEntry('servers', 'server', id)
  }

  async updateServer(id: string, input: unknown): Promise<void> {
    // NOTE: a URL change rekeys the connector but does NOT re-register the Jack
    // indexer/download-client already bound in *arr (that needs a restart), and there
    // is no download cascade (downloads key off peers, not servers) — so no onRekey.
    const resolved = ServerConfig.parse(input)
    const rawServer = RawServerConfig.parse(input)
    return this.updateEntry('servers', 'server', id, resolved, rawServer, () => this.connectorManager.addServerConnector(resolved, { rethrowInitError: true }))
  }

  // ── Jack ───────────────────────────────────────────────────────────────────
  // jack is a singular object (not an array slice), so it bypasses the generic
  // CRUD helpers. Its values are captured at boot (main key / qB / torznab /
  // *arr autoregister), so there is NO live connector to reconcile — persisting
  // the new block is the whole job; it takes effect on the next restart.
  async updateJack(input: unknown): Promise<void> {
    // Validate + resolve secrets up front (bad shape / unresolvable ref → 400
    // before any write, mirroring addPeer); persist the ref-preserving
    // RawJackConfig parse so {env}/{file} refs survive the round-trip to disk.
    JackConfig.parse(input)
    const rawJack = RawJackConfig.parse(input)
    return this.enqueue(async () => {
      const next = { ...this.raw, jack: rawJack } as RawConfig
      await this.persist(next)
      this.raw = next
    })
  }
}
