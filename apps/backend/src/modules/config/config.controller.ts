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
  return { ...stringifyConnector(c), source: c.canSource, destination: c.canDestination }
}

function stringifyPeer(c: PeerConnector) {
  return { ...stringifyConnector(c), version: c.peerVersion }
}

export class ConfigController {
  constructor(
    private readonly connectors: { servers: ArrServerConnector[], peers: PeerConnector[] },
    private readonly configService?: ConfigService,
  ) {}

  listConfig() {
    return {
      servers: this.connectors.servers.map(stringifyServer),
      peers: this.connectors.peers.map(stringifyPeer),
    }
  }

  listPeers() {
    return { peers: this.connectors.peers.map(stringifyPeer) }
  }

  listServers() {
    return { servers: this.connectors.servers.map(stringifyServer) }
  }

  /** Whether mutation endpoints are available (a ConfigService was injected). */
  get canMutate() {
    return this.configService !== undefined
  }

  // Single funnel for every mutation: guarantees a service is present and maps a Zod
  // validation failure to a 400. The router only mounts mutation routes when
  // `canMutate`, so the guard here is defensive — direct callers still get a clear error.
  async #mutate(run: (service: ConfigService) => Promise<void>) {
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

  addPeer(input: unknown) {
    return this.#mutate(s => s.addPeer(input))
  }

  removePeer(id: string) {
    return this.#mutate(s => s.removePeer(id))
  }

  updatePeer(id: string, input: unknown) {
    return this.#mutate(s => s.updatePeer(id, input))
  }

  addServer(input: unknown) {
    return this.#mutate(s => s.addServer(input))
  }

  removeServer(id: string) {
    return this.#mutate(s => s.removeServer(id))
  }

  updateServer(id: string, input: unknown) {
    return this.#mutate(s => s.updateServer(id, input))
  }
}
