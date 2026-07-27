import type { QbittorrentController } from './qbittorrent.controller'
import type { QbSession } from './qbittorrent.session'
import { Hono } from 'hono'
import { describeRoute } from 'hono-openapi'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import { createMiddleware } from 'hono/factory'

const SID_COOKIE = 'SID'

// Splits a multiline `urls` field into individual entries (CRLF or LF).
const NEWLINE = /\r?\n/

export function getQbittorrentRouter(controller: QbittorrentController) {
  const app = new Hono<{ Variables: { qbSession: QbSession } }>()

  // ---- Public: auth (qB returns "Ok."/"Fails." as text) ----
  app.post('/auth/login', describeRoute({
    tags: ['qBittorrent'],
    summary: 'Log in',
    description: 'Form fields `username`/`password`. The password must be the master key or a managed key; on success a SID session cookie is set. Mirrors qBittorrent: the body is `Ok.` or `Fails.`, always 200.',
    responses: { 200: { description: '`Ok.` with a SID cookie, or `Fails.`', content: { 'text/plain': {} } } },
  }), async (c) => {
    const body = await c.req.parseBody()
    const sid = controller.login(String(body.username ?? ''), String(body.password ?? ''))
    if (!sid)
      return c.text('Fails.', 200)
    setCookie(c, SID_COOKIE, sid, { path: '/', httpOnly: true, sameSite: 'Strict' })
    return c.text('Ok.', 200)
  })

  app.post('/auth/logout', describeRoute({
    tags: ['qBittorrent'],
    summary: 'Log out',
    security: [{ SID: [] }],
    responses: { 200: { description: '`Ok.`; the SID cookie is cleared', content: { 'text/plain': {} } } },
  }), (c) => {
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
  const qbAuth = { security: [{ SID: [] }] }
  app.get('/app/webapiVersion', describeRoute({
    tags: ['qBittorrent'],
    summary: 'WebAPI version',
    ...qbAuth,
    responses: { 200: { description: 'The emulated qBittorrent WebAPI version', content: { 'text/plain': {} } } },
  }), c => c.text(controller.webapiVersion()))
  app.get('/app/version', describeRoute({
    tags: ['qBittorrent'],
    summary: 'Application version',
    ...qbAuth,
    responses: { 200: { description: 'The emulated qBittorrent application version', content: { 'text/plain': {} } } },
  }), c => c.text(controller.version()))
  app.get('/app/preferences', describeRoute({
    tags: ['qBittorrent'],
    summary: 'Client preferences',
    ...qbAuth,
    responses: { 200: { description: 'qBittorrent-shaped preferences object', content: { 'application/json': {} } } },
  }), c => c.json(controller.preferences()))

  // ---- torrents (connection-test surface; Phase 2 fills info with real data) ----
  app.get('/torrents/info', describeRoute({
    tags: ['qBittorrent'],
    summary: 'List torrents',
    description: '*arr polls this for download progress. Optional `category` and `hashes` (pipe-separated) filters.',
    ...qbAuth,
    parameters: [
      { name: 'category', in: 'query', schema: { type: 'string' }, description: 'Filter by category' },
      { name: 'hashes', in: 'query', schema: { type: 'string' }, description: 'Pipe-separated torrent hashes' },
    ],
    responses: { 200: { description: 'qBittorrent-shaped torrent list', content: { 'application/json': {} } } },
  }), (c) => {
    const category = c.req.query('category') ?? undefined
    const hashesRaw = c.req.query('hashes')
    const hashes = hashesRaw ? hashesRaw.split('|') : undefined
    return c.json(controller.torrentsInfo({ category, hashes }))
  })
  app.get('/torrents/properties', describeRoute({
    tags: ['qBittorrent'],
    summary: 'Torrent properties',
    ...qbAuth,
    parameters: [{ name: 'hash', in: 'query', required: true, schema: { type: 'string' } }],
    responses: {
      200: { description: 'Properties for the torrent', content: { 'application/json': {} } },
      404: { description: 'Unknown hash' },
    },
  }), (c) => {
    const props = controller.torrentProperties(c.req.query('hash') ?? '')
    if (!props)
      return c.body(null, 404)
    return c.json(props)
  })
  app.get('/torrents/files', describeRoute({
    tags: ['qBittorrent'],
    summary: 'Torrent file list',
    ...qbAuth,
    parameters: [{ name: 'hash', in: 'query', required: true, schema: { type: 'string' } }],
    responses: { 200: { description: 'Files belonging to the torrent', content: { 'application/json': {} } } },
  }), c => c.json(controller.torrentFiles(c.req.query('hash') ?? '')))
  app.get('/torrents/categories', describeRoute({
    tags: ['qBittorrent'],
    summary: 'List categories',
    ...qbAuth,
    responses: { 200: { description: 'Known categories keyed by name', content: { 'application/json': {} } } },
  }), c => c.json(controller.categories()))

  app.post('/torrents/add', describeRoute({
    tags: ['qBittorrent'],
    summary: 'Add a torrent',
    description: 'Multipart/form upload of stub `.torrent` files (`torrents`) and/or download URLs (`urls`, newline-separated), with an optional `category`. Only Jack stubs are accepted; each one queues an HTTP download from the owning peer.',
    ...qbAuth,
    responses: {
      200: { description: '`Ok.` — download queued', content: { 'text/plain': {} } },
      415: { description: 'Not a Jack stub torrent', content: { 'text/plain': {} } },
      503: { description: 'Download pipeline unavailable or failed to start', content: { 'text/plain': {} } },
    },
  }), async (c) => {
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

  app.post('/torrents/delete', describeRoute({
    tags: ['qBittorrent'],
    summary: 'Delete torrents',
    description: 'Form fields `hashes` (pipe-separated) and `deleteFiles` (`true`/`false`).',
    ...qbAuth,
    responses: { 200: { description: '`Ok.`', content: { 'text/plain': {} } } },
  }), async (c) => {
    const session = c.get('qbSession')
    const body = await c.req.parseBody()
    await controller.deleteTorrents(session, String(body.hashes ?? ''), String(body.deleteFiles ?? 'false') === 'true')
    return c.text('Ok.', 200)
  })

  app.post('/torrents/setCategory', describeRoute({
    tags: ['qBittorrent'],
    summary: 'Set torrent category',
    description: 'Form fields `hashes` (pipe-separated) and `category`.',
    ...qbAuth,
    responses: { 200: { description: '`Ok.`', content: { 'text/plain': {} } } },
  }), async (c) => {
    const session = c.get('qbSession')
    const body = await c.req.parseBody()
    controller.setCategory(session, String(body.hashes ?? '').split('|').filter(Boolean), String(body.category ?? ''))
    return c.text('Ok.', 200)
  })

  const noop = (summary: string) => describeRoute({
    tags: ['qBittorrent'],
    summary,
    description: 'Acknowledged no-op: jack doesn\'t seed or prioritize, but *arr expects a 200 (real qBittorrent returns one too).',
    ...qbAuth,
    responses: { 200: { description: '`Ok.`', content: { 'text/plain': {} } } },
  })
  app.post('/torrents/createCategory', noop('Create a category'), c => c.text('Ok.', 200))

  // Best-effort: *arr issues these for priority/seeding; jack doesn't seed, so
  // acknowledge and no-op (real qB returns 200 here too).
  app.post('/torrents/setShareLimits', noop('Set share limits'), c => c.text('Ok.', 200))
  app.post('/torrents/topPrio', noop('Move to top priority'), c => c.text('Ok.', 200))
  app.post('/torrents/setForceStart', noop('Set force start'), c => c.text('Ok.', 200))

  return app
}
