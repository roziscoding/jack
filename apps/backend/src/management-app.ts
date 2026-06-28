import type { ConnectorManager } from './lib/servers'
import type { ApiKeysRepository } from './modules/api-keys/api-keys.repository'
import type { ConfigService } from './modules/config/config.service'
import type { DownloadsRepository } from './modules/downloads/downloads.repository'
import type { DownloadsService } from './modules/downloads/downloads.service'
import { Hono } from 'hono'
import { secureHeaders } from 'hono/secure-headers'
import { TmdbClient } from './lib/tmdb/client'
import { handleError } from './middleware/handle-error'
import { requireManagementKey } from './middleware/require-management-key'
import { ApiKeysController } from './modules/api-keys/api-keys.controller'
import { getApiKeysRouter } from './modules/api-keys/api-keys.router'
import { CatalogController } from './modules/catalog/catalog.controller'
import { getCatalogRouter } from './modules/catalog/catalog.router'
import { ConfigController } from './modules/config/config.controller'
import { getConfigRouter } from './modules/config/config.router'
import { StatusController } from './modules/status/status.controller'
import { getStatusRouter } from './modules/status/status.router'

export function getManagementApp(params: {
  environment: string
  managementKey: string
  // The live manager (its `servers`/`peers` getters are read per request).
  connectors: { servers: ConnectorManager['servers'], peers: ConnectorManager['peers'] }
  configService?: ConfigService
  downloadsRepository?: DownloadsRepository
  downloadsService?: DownloadsService
  apiKeysRepository?: ApiKeysRepository
  tmdbApiKey?: string
}) {
  const app = new Hono()

  app.use('*', secureHeaders())
  // The entire surface is key-guarded; no route is reachable without it.
  app.use('*', requireManagementKey(params.managementKey))

  // Cheap key-guarded probe for the UI's BFF: reaching it 200 proves the key is
  // valid and the management API is up; a connection error proves it's disabled.
  app.get('/ping', c => c.json({ ok: true }))

  const configController = new ConfigController(params.connectors, params.configService)
  app.route('/config', getConfigRouter(configController))

  const statusController = new StatusController(params.connectors, params.downloadsRepository)
  app.route('/', getStatusRouter(statusController))

  const tmdbClient = params.tmdbApiKey ? new TmdbClient(params.tmdbApiKey) : undefined
  const catalogController = new CatalogController(params.connectors, tmdbClient, params.downloadsService)
  app.route('/catalog', getCatalogRouter(catalogController))

  if (params.apiKeysRepository) {
    const apiKeysController = new ApiKeysController(params.apiKeysRepository)
    app.route('/api-keys', getApiKeysRouter(apiKeysController))
  }

  // The management API is key-guarded and serves the admin UI, so it exposes
  // full error detail. The peer-facing app (app.ts) leaves this off and returns
  // opaque errors instead.
  app.onError(handleError(params.environment, { exposeDetails: true }))

  return app
}
