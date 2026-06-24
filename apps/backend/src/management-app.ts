import type { ConnectorManager } from './lib/servers'
import type { ConfigService } from './modules/config/config.service'
import type { DownloadsRepository } from './modules/downloads/downloads.repository'
import { Hono } from 'hono'
import { secureHeaders } from 'hono/secure-headers'
import { handleError } from './middleware/handle-error'
import { requireManagementKey } from './middleware/require-management-key'
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

  app.onError(handleError(params.environment))

  return app
}
