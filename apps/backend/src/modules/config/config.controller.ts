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

  async addPeer(input: unknown) {
    if (!this.configService)
      throw new Error('Config mutations require a configured ConfigService')
    try {
      await this.configService.addPeer(input)
    }
    catch (err) {
      if (err instanceof z.ZodError)
        throw new BadRequestError(z.prettifyError(err))
      throw err
    }
    return { ok: true }
  }
}
