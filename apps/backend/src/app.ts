import type { AppConfig } from './lib/config'
import type { ArrServerConnector } from './lib/servers/arr/base'
import type { PeerConnector } from './lib/servers/peer'
import { Hono } from 'hono'
import { AppError } from './lib/errors/AppError'
import { FetchError } from './lib/errors/FetchError'
import { logger } from './logger'
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
  servers: ArrServerConnector[]
  peers: PeerConnector[]
}

export function getApp(config: AppConfig, connectors: Connectors) {
  const app = new Hono()

  // Log every request at trace level once it's done: method, path, status, and
  // duration.
  app.use('*', async (c, next) => {
    const start = performance.now()
    await next()
    const durationMs = Math.round((performance.now() - start) * 100) / 100
    logger.trace({ method: c.req.method, path: c.req.path, status: c.res.status, durationMs }, 'Request completed')
  })

  // Health check — unauthenticated, used by Docker/orchestrators.
  app.get('/ping', c => c.json({ status: 'OK' }, 200))

  const serversController = new ServersController({ servers: connectors.servers, peers: connectors.peers })
  const itemsController = new ItemsController({ sources: connectors.servers })

  app.route('/servers', getServersRouter(serversController))
  app.route('/items', getItemsRouter(itemsController))

  if (config.jack) {
    const jackConfig = config.jack

    // Peer API — other Jacks talk to us. Always mounted; serves empty results
    // when there's no local source to read from.
    const peerController = new PeerController(connectors.servers)
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
