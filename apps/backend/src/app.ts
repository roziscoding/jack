import type { AppConfig } from './lib/config'
import type { DestinationServerConnector } from './lib/servers/destinations/base'
import type { SourceServerConnector } from './lib/servers/sources/base'
import type { JackServerConnector } from './lib/servers/sources/jack'
import type { JellyfinServerConnector } from './lib/servers/sources/jellyfin'
import { Hono } from 'hono'
import { AppError } from './lib/errors/AppError'
import { FetchError } from './lib/errors/FetchError'
import { ItemsController } from './modules/items/items.controller'
import { getItemsRouter } from './modules/items/items.router'
import { ServersController } from './modules/servers/servers.controllers'
import { getServersRouter } from './modules/servers/servers.router'
import { PeerController } from './modules/peer/peer.controller'
import { getPeerRouter } from './modules/peer/peer.router'
import { TorznabController } from './modules/torznab/torznab.controller'
import { getTorznabRouter } from './modules/torznab/torznab.router'
import { getDownloadRouter } from './modules/torznab/download.router'

interface Connectors {
  sources: SourceServerConnector[]
  peers: JackServerConnector[]
  destinations: DestinationServerConnector[]
}

export function getApp(config: AppConfig, connectors: Connectors) {
  const app = new Hono()

  const serversController = new ServersController(connectors)
  const itemsController = new ItemsController(connectors)

  app.route('/servers', getServersRouter(serversController))
  app.route('/items', getItemsRouter(itemsController))

  if (config.jack) {
    const jackConfig = config.jack

    // Peer API — other Jacks talk to us. Always mounted; serves empty results
    // when there's no local source to read from.
    const localJellyfin = connectors.sources.find(s => s.type === 'jellyfin') as JellyfinServerConnector | undefined
    const peerController = new PeerController(localJellyfin, jackConfig)
    app.route('/peer', getPeerRouter(peerController, jackConfig.apiKey))

    // Torznab API — Radarr/Sonarr search through us. Always mounted; returns
    // empty results when there are no peers to fan out to.
    const torznabController = new TorznabController(connectors.peers, jackConfig)
    app.route('/torznab', getTorznabRouter(torznabController, jackConfig.apiKey))
    app.route('/torznab', getDownloadRouter(connectors.peers, jackConfig.apiKey))
  }

  app.onError((err, c) => {
    if (err instanceof FetchError) {
      return c.json({ error: err.message, code: err.code }, 502)
    }

    if (err instanceof AppError) {
      return c.json({ error: err.message, code: err.code }, 500)
    }

    return c.json({ error: err.message, code: 'UNKNOWN_ERROR' }, 500)
  })

  return app
}
