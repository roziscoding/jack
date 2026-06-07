import type { QbittorrentController } from './qbittorrent.controller'
import type { QbSession } from './qbittorrent.session'
import { Hono } from 'hono'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import { createMiddleware } from 'hono/factory'

const SID_COOKIE = 'SID'

// Splits a multiline `urls` field into individual entries (CRLF or LF).
const NEWLINE = /\r?\n/

export function getQbittorrentRouter(controller: QbittorrentController) {
  const app = new Hono<{ Variables: { qbSession: QbSession } }>()

  // ---- Public: auth (qB returns "Ok."/"Fails." as text) ----
  app.post('/auth/login', async (c) => {
    const body = await c.req.parseBody()
    const sid = controller.login(String(body.username ?? ''), String(body.password ?? ''))
    if (!sid)
      return c.text('Fails.', 200)
    setCookie(c, SID_COOKIE, sid, { path: '/', httpOnly: true, sameSite: 'Strict' })
    return c.text('Ok.', 200)
  })

  app.post('/auth/logout', (c) => {
    controller.logout(getCookie(c, SID_COOKIE))
    deleteCookie(c, SID_COOKIE, { path: '/' })
    return c.text('Ok.', 200)
  })

  // ---- SID guard: qB returns 403 (not 401) when unauthenticated ----
  const requireSession = createMiddleware<{ Variables: { qbSession: QbSession } }>(async (c, next) => {
    const session = controller.sessions.get(getCookie(c, SID_COOKIE))
    if (!session)
      return c.text('Forbidden', 403)
    c.set('qbSession', session)
    await next()
  })
  app.use('/app/*', requireSession)
  app.use('/torrents/*', requireSession)

  // ---- app ----
  app.get('/app/webapiVersion', c => c.text(controller.webapiVersion()))
  app.get('/app/version', c => c.text(controller.version()))
  app.get('/app/preferences', c => c.json(controller.preferences()))

  // ---- torrents (connection-test surface; Phase 2 fills info with real data) ----
  app.get('/torrents/info', (c) => {
    const category = c.req.query('category') ?? undefined
    const hashesRaw = c.req.query('hashes')
    const hashes = hashesRaw ? hashesRaw.split('|') : undefined
    return c.json(controller.torrentsInfo({ category, hashes }))
  })
  app.get('/torrents/properties', (c) => {
    const props = controller.torrentProperties(c.req.query('hash') ?? '')
    if (!props)
      return c.body(null, 404)
    return c.json(props)
  })
  app.get('/torrents/files', c => c.json(controller.torrentFiles(c.req.query('hash') ?? '')))
  app.get('/torrents/categories', c => c.json(controller.categories()))

  app.post('/torrents/add', async (c) => {
    const session = c.get('qbSession')
    const body = await c.req.parseBody({ all: true })

    // Normalize: parseBody({ all: true }) returns string | File | Array of those.
    const asList = (v: unknown): unknown[] => (Array.isArray(v) ? v : v == null ? [] : [v])
    const firstString = (v: unknown): string | undefined => asList(v).find((x): x is string => typeof x === 'string')

    const urls = asList(body.urls)
      .flatMap(v => (typeof v === 'string' ? v.split(NEWLINE) : []))
      .map(s => s.trim())
      .filter(Boolean)

    const torrentFiles: Uint8Array[] = []
    for (const f of asList(body.torrents)) {
      if (f instanceof File)
        torrentFiles.push(new Uint8Array(await f.arrayBuffer()))
    }

    const category = firstString(body.category)
    const result = await controller.addTorrent({ session, category, urls, torrentFiles })
    if (result === 'unavailable')
      return c.text('Download pipeline unavailable: jack has no downloads config.', 503)
    if (result === 'failed')
      return c.text('Failed to start download. Retry later.', 503)
    if (result === 'unsupported')
      return c.text('Unsupported torrent. Only Jack releases are accepted.', 415)
    return c.text('Ok.', 200)
  })

  app.post('/torrents/delete', async (c) => {
    const session = c.get('qbSession')
    const body = await c.req.parseBody()
    await controller.deleteTorrents(session, String(body.hashes ?? ''), String(body.deleteFiles ?? 'false') === 'true')
    return c.text('Ok.', 200)
  })

  app.post('/torrents/setCategory', async (c) => {
    const session = c.get('qbSession')
    const body = await c.req.parseBody()
    controller.setCategory(session, String(body.hashes ?? '').split('|').filter(Boolean), String(body.category ?? ''))
    return c.text('Ok.', 200)
  })

  app.post('/torrents/createCategory', c => c.text('Ok.', 200))

  // Best-effort: *arr issues these for priority/seeding; jack doesn't seed, so
  // acknowledge and no-op (real qB returns 200 here too).
  app.post('/torrents/setShareLimits', c => c.text('Ok.', 200))
  app.post('/torrents/topPrio', c => c.text('Ok.', 200))
  app.post('/torrents/setForceStart', c => c.text('Ok.', 200))

  return app
}
