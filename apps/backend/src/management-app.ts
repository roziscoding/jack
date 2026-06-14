import type { ConnectorManager } from './lib/servers'
import type { ConfigService } from './modules/config/config.service'
import { Hono } from 'hono'
import { secureHeaders } from 'hono/secure-headers'
import { handleError } from './middleware/handle-error'
import { requireManagementKey } from './middleware/require-management-key'
import { ConfigController } from './modules/config/config.controller'
import { getConfigRouter } from './modules/config/config.router'

export function getManagementApp(params: {
  environment: string
  managementKey: string
  // The live manager (its `servers`/`peers` getters are read per request).
  connectors: { servers: ConnectorManager['servers'], peers: ConnectorManager['peers'] }
  configService?: ConfigService
}) {
  const app = new Hono()

  app.use('*', secureHeaders())
  // The entire surface is key-guarded; no route is reachable without it.
  app.use('*', requireManagementKey(params.managementKey))

  const configController = new ConfigController(params.connectors, params.configService)
  app.route('/config', getConfigRouter(configController))

  app.onError(handleError(params.environment))

  return app
}
