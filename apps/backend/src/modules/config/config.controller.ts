import type { ArrServerConnector } from '../../lib/servers/arr/base'
import type { ServerConnector } from '../../lib/servers/base'
import type { PeerConnector } from '../../lib/servers/peer'
import type { ConfigService } from './config.service'
import { z } from 'zod'
import { BadRequestError } from '../../lib/errors/BadRequestError'

function stringifyConnector(c: ServerConnector) {
  return {
    id: c.id,
    name: c.name,
    url: c.url,
    type: c.type,
    initialized: c.isInitialized,
    initializationError: c.initializationError,
  }
}

function stringifyServer(c: ArrServerConnector) {
  return {
    ...stringifyConnector(c),
    source: c.canSource,
    destination: c.canDestination,
    // Effective (defaults-applied) autoregister so the edit form prefills what's
    // actually in effect, not just what the file happened to spell out.
    autoregister: { enable: c.autoRegister.enable, priority: c.autoRegister.priority },
  }
}

function stringifyPeer(c: PeerConnector) {
  return { ...stringifyConnector(c), version: c.peerVersion }
}

export class ConfigController {
  constructor(
    private readonly connectors: { servers: ArrServerConnector[], peers: PeerConnector[], subscribe?: (subscriber: () => void) => () => void },
    private readonly configService?: ConfigService,
  ) {}

  subscribe(subscriber: () => void): () => void {
    const unsubscribers = [
      this.connectors.subscribe?.(subscriber),
      this.configService?.subscribe(subscriber),
    ].filter((unsubscribe): unsubscribe is () => void => Boolean(unsubscribe))
    return () => {
      for (const unsubscribe of unsubscribers)
        unsubscribe()
    }
  }

  // Merge the persisted, refs-intact `apiKey`/`headers` onto a serialized connector
  // so an edit form can prefill them. Refs (`{env}`/`{file}`) come straight from the
  // file via the ConfigService; the live connector only holds resolved values, so a
  // read-only deployment (no ConfigService) simply omits them.
  private withSecrets<T extends { id: string }>(kind: 'peers' | 'servers', serialized: T) {
    const raw = this.configService?.getRawSecrets(kind, serialized.id)
    if (!raw)
      return serialized
    return { ...serialized, apiKey: raw.apiKey, headers: raw.headers }
  }

  listConfig() {
    return {
      servers: this.connectors.servers.map(s => this.withSecrets('servers', stringifyServer(s))),
      peers: this.connectors.peers.map(p => this.withSecrets('peers', stringifyPeer(p))),
    }
  }

  listPeers() {
    return { peers: this.connectors.peers.map(p => this.withSecrets('peers', stringifyPeer(p))) }
  }

  listServers() {
    return { servers: this.connectors.servers.map(s => this.withSecrets('servers', stringifyServer(s))) }
  }

  /** Refs-intact jack config for an edit form, or null when unset / read-only. */
  getJack() {
    return this.configService?.getRawJack() ?? null
  }

  /** Persisted downloads block for an edit form, or null when unset / read-only. */
  getDownloads() {
    return this.configService?.getRawDownloads() ?? null
  }

  /** Whether mutation endpoints are available (a ConfigService was injected). */
  get canMutate() {
    return this.configService !== undefined
  }

  // Single funnel for every mutation: guarantees a service is present and maps a Zod
  // validation failure to a 400. The router only mounts mutation routes when
  // `canMutate`, so the guard here is defensive — direct callers still get a clear error.
  private async mutate(run: (service: ConfigService) => Promise<void>) {
    if (!this.configService)
      throw new Error('Config mutations require a configured ConfigService')
    try {
      await run(this.configService)
    }
    catch (err) {
      if (err instanceof z.ZodError)
        throw new BadRequestError(z.prettifyError(err))
      throw err
    }
    return { ok: true }
  }

  addPeer(input: unknown, opts?: { force?: boolean }) {
    return this.mutate(s => s.addPeer(input, opts))
  }

  removePeer(id: string) {
    return this.mutate(s => s.removePeer(id))
  }

  updatePeer(id: string, input: unknown, opts?: { force?: boolean }) {
    return this.mutate(s => s.updatePeer(id, input, opts))
  }

  addServer(input: unknown) {
    return this.mutate(s => s.addServer(input))
  }

  removeServer(id: string) {
    return this.mutate(s => s.removeServer(id))
  }

  updateServer(id: string, input: unknown) {
    return this.mutate(s => s.updateServer(id, input))
  }

  updateJack(input: unknown) {
    return this.mutate(s => s.updateJack(input))
  }

  updateDownloads(input: unknown) {
    return this.mutate(s => s.updateDownloads(input))
  }
}
