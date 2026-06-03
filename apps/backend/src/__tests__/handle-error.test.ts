import { describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { UnauthorizedError } from '../lib/errors/UnauthorizedError'
import { handleError } from '../middleware/handle-error'

function createApp() {
  const app = new Hono()
  app.get('/protected', () => {
    throw new UnauthorizedError('invalid API key')
  })
  app.onError(handleError('test'))
  return app
}

describe('handleError', () => {
  test('returns JSON 401 for unauthorized requests that accept JSON', async () => {
    const app = createApp()

    for (const accept of [undefined, 'application/json', '*/*']) {
      const res = await app.request('/protected', accept ? { headers: { Accept: accept } } : undefined)
      expect(res.status).toBe(401)
      expect(res.headers.get('Content-Type')).toContain('application/json')

      const body = await res.json() as { ok: boolean, error: { code: string, message: string } }
      expect(body.ok).toBe(false)
      expect(body.error.code).toBe('UNAUTHORIZED')
      expect(body.error.message).toBe('Unauthorized: invalid API key')
    }
  })

  test('returns Torznab-compatible XML 200 for unauthorized requests that accept XML', async () => {
    const app = createApp()

    for (const accept of ['application/rss+xml', 'application/xml+rss', 'application/xml', 'text/xml']) {
      const res = await app.request('/protected', { headers: { Accept: accept } })
      expect(res.status).toBe(200)
      expect(res.headers.get('Content-Type')).toContain('application/xml')

      const body = await res.text()
      expect(body).toContain('<error code="100"')
      expect(body).toContain('description="Unauthorized: invalid API key"')
    }
  })
})
