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
import { PeerController } from './modules/peer/peer.controller'
import { getPeerRouter } from './modules/peer/peer.router'
import { QbittorrentController } from './modules/qbittorrent/qbittorrent.controller'
import { getQbittorrentRouter } from './modules/qbittorrent/qbittorrent.router'
import { getDownloadRouter } from './modules/torznab/download.router'
import { TorznabController } from './modules/torznab/torznab.controller'
import { getTorznabRouter } from './modules/torznab/torznab.router'

interface AppServices {
  // Both auth repositories are required: this app mounts the peer scope (api_key)
  // and the *arr scope (managed_key), and each scope must be able to validate its
  // own key class (see require-auth.ts).
  apiKeysRepository: ApiKeysRepository
  managedKeysRepository: ManagedKeysRepository
  downloadsRepository?: DownloadsRepository
  downloadsService?: DownloadsService
}

// This is the external surface, gated per audience rather than by one global key:
//  - peers (other Jacks) reach /handshake + /peer/* with regular api_keys;
//  - the operator's Radarr/Sonarr reach /torznab/* (managed key) and /api/v2/*
//    (qBittorrent, own SID-cookie auth);
//  - admin/connector/download views live ONLY on the management API.
// Only the live `servers`/`peers` getters are used here, so accept the structural
// shape a real `ConnectorManager` satisfies — this also lets tests pass a lightweight
// `{ servers, peers }` object.
export function getApp(envs: Envs, config: AppConfig, connManager: { servers: ConnectorManager['servers'], peers: ConnectorManager['peers'] }, services: AppServices) {
  const app = new Hono()

  const peerController = new PeerController(() => connManager.servers)

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

  // qBittorrent WebUI API -- Radarr/Sonarr poll us as a download client. It uses its
  // own SID-cookie auth (/api/v2/auth/login), which is itself scoped to master +
  // managed keys (see qbittorrent.controller), so it's mounted outside the api-key
  // scopes below.
  if (config.downloads && services.downloadsRepository) {
    const qbController = new QbittorrentController({
      apiKey: config.jack.apiKey ?? '',
      completedPath: config.downloads.completedPath,
      get servers() { return connManager.servers },
      repository: services.downloadsRepository,
      downloadsService: services.downloadsService,
      managedKeysRepository: services.managedKeysRepository,
    })
    app.route('/api/v2', getQbittorrentRouter(qbController))
  }

  const masterKey = config.jack.apiKey ?? ''
  // Peer scope: other Jacks present regular api_keys. *arr scope: the operator's
  // Radarr/Sonarr present the managed key Jack registered with them.
  const peerAuth = requireApiKey(masterKey, { type: 'api_key', repository: services.apiKeysRepository })
  const arrAuth = requireApiKey(masterKey, { type: 'managed_key', repository: services.managedKeysRepository })

  // Peer handshake — other Jacks probe this at init to read our identity and
  // protocol version, then check it against their minimum compatible version.
  // Authenticated so a bad API key still fails loudly at connect time, unlike the
  // unauthenticated /ping health check.
  app.get('/handshake', peerAuth, c => c.json({ name: 'jack', version: PROTOCOL_VERSION }, 200))

  // Peer API — other Jacks talk to us to search and download. Serves empty results
  // when there's no local source to read from.
  app.use('/peer/*', peerAuth)
  app.route('/peer', getPeerRouter(peerController))

  // Torznab API — the operator's Radarr/Sonarr search through us and grab via the
  // download router. Returns empty results when there are no peers to fan out to.
  const torznabController = new TorznabController(() => connManager.peers, config.jack)
  app.use('/torznab/*', arrAuth)
  app.route('/torznab', getTorznabRouter(torznabController))
  app.route('/torznab', getDownloadRouter(() => connManager.peers))

  // Peer-facing app: error responses are opaque (see handle-error.ts).
  app.onError(handleError(envs.ENVIRONMENT))

  return app
}
