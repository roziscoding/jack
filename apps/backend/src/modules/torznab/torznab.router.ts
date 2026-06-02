import type { TorznabController } from './torznab.controller'
import { Hono } from 'hono'
import { logger } from '../../logger'
import { buildCapsXml, buildErrorXml, buildSearchResultXml } from './torznab.xml'

export function getTorznabRouter(controller: TorznabController, apiKey: string) {
  const app = new Hono()

  app.get('/api', async (c) => {
    const t = c.req.query('t')
    const key = c.req.query('apikey')

    if (key !== apiKey) {
      logger.warn('Torznab request rejected: incorrect API key')
      return c.body(buildErrorXml(100, 'Incorrect API Key'), 403, {
        'Content-Type': 'application/xml',
      })
    }

    if (!t) {
      logger.warn('Torznab request rejected: missing parameter "t"')
      return c.body(buildErrorXml(200, 'Missing parameter: t'), 400, {
        'Content-Type': 'application/xml',
      })
    }

    logger.debug({
      t,
      q: c.req.query('q'),
      imdbid: c.req.query('imdbid'),
      tvdbid: c.req.query('tvdbid'),
      season: c.req.query('season'),
      ep: c.req.query('ep'),
      cat: c.req.query('cat'),
    }, 'Torznab request received')

    switch (t) {
      case 'caps': {
        return c.body(buildCapsXml(), 200, {
          'Content-Type': 'application/xml',
        })
      }

      case 'search': {
        const q = c.req.query('q') ?? ''
        const items = await controller.search(q)
        return c.body(buildSearchResultXml(items), 200, {
          'Content-Type': 'application/xml',
        })
      }

      case 'movie': {
        const imdbId = c.req.query('imdbid')
        if (!imdbId) {
          const q = c.req.query('q') ?? ''
          const items = await controller.search(q)
          return c.body(buildSearchResultXml(items), 200, {
            'Content-Type': 'application/xml',
          })
        }
        const items = await controller.searchMovie(imdbId)
        return c.body(buildSearchResultXml(items), 200, {
          'Content-Type': 'application/xml',
        })
      }

      case 'tvsearch': {
        const tvdbId = c.req.query('tvdbid')
        const season = c.req.query('season')
        const ep = c.req.query('ep')

        if (!tvdbId) {
          const q = c.req.query('q') ?? ''
          const items = await controller.search(q)
          return c.body(buildSearchResultXml(items), 200, {
            'Content-Type': 'application/xml',
          })
        }

        const items = await controller.searchTv(
          tvdbId,
          season ? Number(season) : undefined,
          ep ? Number(ep) : undefined,
        )
        return c.body(buildSearchResultXml(items), 200, {
          'Content-Type': 'application/xml',
        })
      }

      default: {
        return c.body(buildErrorXml(202, `Unknown function: ${t}`), 400, {
          'Content-Type': 'application/xml',
        })
      }
    }
  })

  return app
}
