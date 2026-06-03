import type { TorznabController, TorznabItem } from './torznab.controller'
import { Hono } from 'hono'
import { xml } from '../../helpers/xml'
import { logger } from '../../logger'

const CAPS_XML = {
  caps: {
    server: {
      '@version': '0.0',
      '@title': 'Jack',
    },
    limits: {
      '@max': 99,
      '@default': 49,
    },
    searching: {
      'search': {
        '@available': 'yes',
        '@supportedParams': 'q',
      },
      'tv-search': {
        '@available': 'yes',
        '@supportedParams': 'tvdbid,season,ep',
      },
      'movie-search': {
        '@available': 'yes',
        '@supportedParams': 'imdbid,tmdbid',
      },
    },
    categories: {
      category: [
        { '@id': 2000, '@name': 'Movies' },
        { '@id': 5000, '@name': 'TV' },
      ],
    },
  },
}

/**
 * Filter items by the torznab `cat` param (comma-separated category ids). Each
 * requested id is rolled up to its top-level bucket (2010 -> 2000), so a movie
 * (2000) matches `cat=2000` or any 2xxx subcategory, and TV (5000) matches 5xxx.
 * No `cat` (or an unparseable one) means no filtering.
 */
function filterByCategory(items: TorznabItem[], cat?: string): TorznabItem[] {
  if (!cat)
    return items
  const buckets = new Set(
    cat.split(',')
      .map(c => Math.floor(Number(c.trim()) / 1000) * 1000)
      .filter(b => Number.isFinite(b) && b > 0),
  )
  if (buckets.size === 0)
    return items
  return items.filter(item => buckets.has(item.category))
}

function itemToObject(item: TorznabItem): Record<string, any> {
  const attrs: Array<Record<string, string | number>> = [
    { '@name': 'category', '@value': item.category },
    { '@name': 'size', '@value': item.size },
    { '@name': 'seeders', '@value': 1 },
    { '@name': 'peers', '@value': 1 },
    // Jack files are always freely available; tell *arr not to weight ratio.
    { '@name': 'downloadvolumefactor', '@value': 0 },
    { '@name': 'uploadvolumefactor', '@value': 1 },
  ]
  if (item.imdbId)
    attrs.push({ '@name': 'imdbid', '@value': item.imdbId })
  if (item.tmdbId != null)
    attrs.push({ '@name': 'tmdbid', '@value': item.tmdbId })
  if (item.tvdbId != null)
    attrs.push({ '@name': 'tvdbid', '@value': item.tvdbId })
  if (item.season != null)
    attrs.push({ '@name': 'season', '@value': item.season })
  if (item.episode != null)
    attrs.push({ '@name': 'episode', '@value': item.episode })

  const pubDate = item.publishDate ? new Date(item.publishDate) : new Date()
  const pubDateStr = Number.isNaN(pubDate.getTime()) ? new Date().toUTCString() : pubDate.toUTCString()

  return {
    'title': item.title,
    'guid': item.guid,
    'pubDate': pubDateStr,
    'size': item.size,
    'link': item.downloadUrl,
    'enclosure': {
      '@url': item.downloadUrl,
      '@length': item.size,
      '@type': 'application/x-bittorrent',
    },
    'torznab:attr': attrs,
  }
}

export function buildSearchResultXml(items: TorznabItem[]): Record<string, any> {
  return {
    rss: {
      '@version': '2.0',
      '@xmlns:torznab': 'http://torznab.com/schemas/2015/feed',
      'channel': {
        title: 'Jack',
        description: 'Jack - Media from friends',
        item: items.map(itemToObject),
      },
    },
  }
}

export function buildErrorXml(code: number, description: string): Record<string, any> {
  return {
    error: {
      '@code': code,
      '@description': description,
    },
  }
}

export function getTorznabRouter(controller: TorznabController) {
  const app = new Hono()

  app.get('/api', async (c) => {
    const t = c.req.query('t')

    if (!t) {
      logger.warn('Torznab request rejected: missing parameter "t"')
      const body = buildErrorXml(200, 'Missing parameter: t')
      return xml(c, body, 400)
    }

    logger.debug({
      params: {
        t,
        q: c.req.query('q'),
        imdbid: c.req.query('imdbid'),
        tvdbid: c.req.query('tvdbid'),
        season: c.req.query('season'),
        ep: c.req.query('ep'),
        cat: c.req.query('cat'),
      },
    }, 'Torznab request received')

    switch (t) {
      case 'caps': {
        return xml(c, CAPS_XML)
      }

      // Text (q) searches are NOT fanned out: *arr always searches by id, and a
      // term would mean listing every peer's whole library. So a term returns
      // empty; a no-term query returns the catalog (powers RSS + the indexer
      // self-test, which *arr requires to return results).
      case 'search': {
        const q = c.req.query('q')?.trim()
        const items = q ? [] : await controller.catalog()
        const body = buildSearchResultXml(filterByCategory(items, c.req.query('cat')))
        return xml(c, body)
      }

      case 'movie': {
        const tmdbId = c.req.query('tmdbid')
        const imdbId = c.req.query('imdbid')
        const q = c.req.query('q')?.trim()
        let items: TorznabItem[]
        if (tmdbId || imdbId)
          items = await controller.searchMovie({ tmdbId, imdbId })
        else
          items = q ? [] : await controller.catalog()
        const body = buildSearchResultXml(filterByCategory(items, c.req.query('cat')))
        return xml(c, body)
      }

      case 'tvsearch': {
        const tvdbId = c.req.query('tvdbid')
        const q = c.req.query('q')?.trim()
        let items: TorznabItem[]
        if (tvdbId) {
          const season = c.req.query('season')
          const ep = c.req.query('ep')
          items = await controller.searchTv(
            tvdbId,
            season ? Number(season) : undefined,
            ep ? Number(ep) : undefined,
          )
        }
        else {
          items = q ? [] : await controller.catalog()
        }
        const body = buildSearchResultXml(filterByCategory(items, c.req.query('cat')))
        return xml(c, body)
      }

      default: {
        const body = buildErrorXml(202, `Unknown function: ${t}`)
        return xml(c, body, 400)
      }
    }
  })

  return app
}
