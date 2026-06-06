import type { QbittorrentController } from './qbittorrent.controller'
import type { QbSession } from './qbittorrent.session'
import { Hono } from 'hono'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import { createMiddleware } from 'hono/factory'

const SID_COOKIE = 'SID'

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

  return app
}
