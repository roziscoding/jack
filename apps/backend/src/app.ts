import type { AppConfig } from './lib/config'
import type { ArrServerConnector } from './lib/servers/arr/base'
import type { PeerConnector } from './lib/servers/peer'
import { httpInstrumentationMiddleware } from '@hono/otel'
import { Hono } from 'hono'
import { getAppEnvs, isOtelEnabled } from './lib/envs'
import { AppError } from './lib/errors/AppError'
import { FetchError } from './lib/errors/FetchError'
import { logger } from './logger'
import { ItemsController } from './modules/items/items.controller'
import { getItemsRouter } from './modules/items/items.router'
import { PeerController } from './modules/peer/peer.controller'
import { getPeerRouter } from './modules/peer/peer.router'
import { ServersController } from './modules/servers/servers.controllers'
import { getServersRouter } from './modules/servers/servers.router'
import { getDownloadRouter } from './modules/torznab/download.router'
import { TorznabController } from './modules/torznab/torznab.controller'
import { getTorznabRouter } from './modules/torznab/torznab.router'

interface Connectors {
  servers: ArrServerConnector[]
  peers: PeerConnector[]
}

// Health check path. Hit every few seconds by Docker/orchestrators, so both
// tracing and request logging skip it to avoid flooding traces and logs.
const HEALTHCHECK_PATH = '/ping'

export function getApp(config: AppConfig, connectors: Connectors) {
  const app = new Hono()

  // Wrap every request in an OpenTelemetry server span (method, route, status,
  // duration, ...). Outermost so the span is active for the rest of the chain —
  // including the request log below, which then carries the trace/span ids.
  // Only mounted when tracing is enabled to avoid the per-request overhead.
  if (isOtelEnabled(getAppEnvs())) {
    const otel = httpInstrumentationMiddleware()
    app.use('*', (c, next) => (c.req.path === HEALTHCHECK_PATH ? next() : otel(c, next)))
  }

  // Log every request at trace level once it's done: method, path, status, and
  // duration.
  app.use('*', async (c, next) => {
    if (c.req.path === HEALTHCHECK_PATH)
      return next()

    const start = performance.now()
    await next()
    const durationMs = Math.round((performance.now() - start) * 100) / 100
    logger.trace({ method: c.req.method, path: c.req.path, status: c.res.status, durationMs }, 'Request completed')
  })

  // Health check — unauthenticated, used by Docker/orchestrators.
  app.get(HEALTHCHECK_PATH, c => c.json({ status: 'OK' }, 200))

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
