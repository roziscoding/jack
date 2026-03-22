import type { AppConfig } from './lib/config'
import type { DestinationServerConnector } from './lib/servers/destinations/base'
import type { SourceServerConnector } from './lib/servers/sources/base'
import { Hono } from 'hono'
import { AppError } from './lib/errors/AppError'
import { FetchError } from './lib/errors/FetchError'
import { ItemsController } from './modules/items/items.controller'
import { getItemsRouter } from './modules/items/items.router'
import { ServersController } from './modules/servers/servers.controllers'
import { getServersRouter } from './modules/servers/servers.router'

export function getApp(_config: AppConfig, connectors: { sources: SourceServerConnector[], destinations: DestinationServerConnector[] }) {
  const app = new Hono()

  const serversController = new ServersController(connectors)
  const itemsController = new ItemsController(connectors)

  app.route('/servers', getServersRouter(serversController))
  app.route('/items', getItemsRouter(itemsController))

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
