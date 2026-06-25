import type { AppConfig } from './lib/config'
import type { Envs } from './lib/envs'
import type { ConnectorManager } from './lib/servers'
import type { ApiKeysRepository } from './modules/api-keys/api-keys.repository'
import type { DownloadsRepository } from './modules/downloads/downloads.repository'
import type { DownloadsService } from './modules/downloads/downloads.service'
import type { ManagedKeysRepository } from './modules/managed-keys/managed-keys.repository'
import { httpInstrumentationMiddleware } from '@hono/otel'
import { Hono } from 'hono'
import { secureHeaders } from 'hono/secure-headers'
import { getAppEnvs, isOtelEnabled } from './lib/envs'
import { PROTOCOL_VERSION } from './lib/version'
import { handleError } from './middleware/handle-error'
import { logRequests } from './middleware/log-requests'
import { requireApiKey } from './middleware/require-auth'
import { DownloadsController } from './modules/downloads/downloads.controller'
import { getDownloadsRouter } from './modules/downloads/downloads.router'
import { ItemsController } from './modules/items/items.controller'
import { getItemsRouter } from './modules/items/items.router'
import { PeerController } from './modules/peer/peer.controller'
import { getPeerRouter } from './modules/peer/peer.router'
import { QbittorrentController } from './modules/qbittorrent/qbittorrent.controller'
import { getQbittorrentRouter } from './modules/qbittorrent/qbittorrent.router'
import { ServersController } from './modules/servers/servers.controllers'
import { getServersRouter } from './modules/servers/servers.router'
import { getDownloadRouter } from './modules/torznab/download.router'
import { TorznabController } from './modules/torznab/torznab.controller'
import { getTorznabRouter } from './modules/torznab/torznab.router'

interface AppServices {
  downloadsRepository?: DownloadsRepository
  downloadsService?: DownloadsService
  apiKeysRepository?: ApiKeysRepository
  managedKeysRepository?: ManagedKeysRepository
}

// Only the live `servers`/`peers` getters are used here, so accept the structural
// shape a real `ConnectorManager` satisfies — this also lets tests pass a lightweight
// `{ servers, peers }` object.
export function getApp(envs: Envs, config: AppConfig, connManager: { servers: ConnectorManager['servers'], peers: ConnectorManager['peers'] }, services: AppServices = {}) {
  const app = new Hono()
  const connectors = {
    get servers() {
      return connManager.servers
    },

    get peers() {
      return connManager.peers
    },
  }

  // Controllers
  // ServersController takes { servers, peers } — the live wrapper satisfies it.
  const serversController = new ServersController(connectors)
  // ItemsController treats all servers as sources (unchanged semantics), read live.
  const itemsController = new ItemsController({
    get sources() {
      return connManager.servers
    },
  })
  const peerController = new PeerController(() => connManager.servers)
  const downloadsController = services.downloadsRepository ? new DownloadsController(services.downloadsRepository) : null

  // Routers
  const serversRouter = getServersRouter(serversController)
  const itemsRouter = getItemsRouter(itemsController)
  const peerRouter = getPeerRouter(peerController)
  const downloadsRouter = downloadsController ? getDownloadsRouter(downloadsController) : null

  app.use('*', secureHeaders())

  // Health check — unauthenticated, used by Docker/orchestrators.
  app.get('/ping', c => c.json({ status: 'OK' }, 200))

  // Wrap every request in an OpenTelemetry server span (method, route, status,
  // duration, ...). Outermost so the span is active for the rest of the chain —
  // including the request log below, which then carries the trace/span ids.
  // Only mounted when tracing is enabled to avoid the per-request overhead.
  if (isOtelEnabled(getAppEnvs())) {
    app.use('*', httpInstrumentationMiddleware())
  }

  // Enrich the active request span with HTTP details, then emit a compact
  // request-completed log without headers, query params, or bodies.
  app.use('*', logRequests)

  // qBittorrent WebUI API -- Radarr/Sonarr poll us as a download client. Mounted
  // BEFORE requireApiKey because qB uses its own SID-cookie auth
  // (/api/v2/auth/login), not jack's apikey query/header.
  if (config.jack && config.downloads && services.downloadsRepository) {
    const qbController = new QbittorrentController({
      apiKey: config.jack.apiKey ?? '',
      completedPath: config.downloads.completedPath,
      get servers() { return connManager.servers },
      repository: services.downloadsRepository,
      downloadsService: services.downloadsService,
    })
    app.route('/api/v2', getQbittorrentRouter(qbController))
  }

  app.use('*', requireApiKey(config.jack?.apiKey ?? '', services.apiKeysRepository, services.managedKeysRepository))

  app.route('/servers', serversRouter)
  app.route('/items', itemsRouter)

  if (downloadsRouter)
    app.route('/downloads', downloadsRouter)

  if (config.jack) {
    const jackConfig = config.jack

    const torznabController = new TorznabController(() => connManager.peers, jackConfig)
    const torznabRouter = getTorznabRouter(torznabController)
    const downloadRouter = getDownloadRouter(() => connManager.peers)

    // Peer handshake — other Jacks probe this at init to read our identity and
    // protocol version, then check it against their minimum compatible version.
    // Authenticated (mounted after requireApiKey) so a bad API key still fails
    // loudly at connect time, unlike the unauthenticated /ping health check.
    app.get('/handshake', c => c.json({ name: 'jack', version: PROTOCOL_VERSION }, 200))

    // Peer API — other Jacks talk to us. Serves empty results
    // when there's no local source to read from.
    app.route('/peer', peerRouter)

    // Torznab API — Radarr/Sonarr search through us. Returns empty results when there are no peers to fan out to.
    app.route('/torznab', torznabRouter)
    app.route('/torznab', downloadRouter)
  }

  app.onError(handleError(envs.ENVIRONMENT))

  return app
}
