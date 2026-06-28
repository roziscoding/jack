import { describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { FetchError } from '../lib/errors/FetchError'
import { UnauthorizedError } from '../lib/errors/UnauthorizedError'
import { handleError } from '../middleware/handle-error'

function createApp(options?: { exposeDetails?: boolean }) {
  const app = new Hono()
  app.get('/protected', () => {
    throw new UnauthorizedError('invalid API key')
  })
  app.onError(handleError('test', options))
  return app
}

describe('handleError', () => {
  describe('peer-facing (opaque) responses', () => {
    test('returns an opaque JSON 401 that leaks no detail for requests that accept JSON', async () => {
      const app = createApp()

      for (const accept of [undefined, 'application/json', '*/*']) {
        const res = await app.request('/protected', accept ? { headers: { Accept: accept } } : undefined)
        expect(res.status).toBe(401)
        expect(res.headers.get('Content-Type')).toContain('application/json')

        const body = await res.json() as { ok: boolean, error: { code: string, message: string } }
        expect(body.ok).toBe(false)
        // The stable code is preserved (clients can branch on it)...
        expect(body.error.code).toBe('UNAUTHORIZED')
        // ...but the thrown message is replaced with a generic reason phrase.
        expect(body.error.message).toBe('Unauthorized')
        expect(body.error.message).not.toContain('API key')
      }
    })

    test('returns Torznab-compatible XML 200 with a generic description for requests that accept XML', async () => {
      const app = createApp()

      for (const accept of ['application/rss+xml', 'application/xml+rss', 'application/xml', 'text/xml']) {
        const res = await app.request('/protected', { headers: { Accept: accept } })
        expect(res.status).toBe(200)
        expect(res.headers.get('Content-Type')).toContain('application/xml')

        const body = await res.text()
        expect(body).toContain('<error code="100"')
        expect(body).toContain('description="Unauthorized"')
        expect(body).not.toContain('API key')
      }
    })
  })

  describe('management (detailed) responses', () => {
    test('returns the full message as JSON 401 for requests that accept JSON', async () => {
      const app = createApp({ exposeDetails: true })

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

    test('returns the full message in Torznab XML for requests that accept XML', async () => {
      const app = createApp({ exposeDetails: true })

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

  describe('redaction of credentials', () => {
    function fetchErrorApp(options?: { exposeDetails?: boolean }) {
      const app = new Hono()
      app.get('/upstream', () => {
        throw new FetchError('Failed to fetch url: Forbidden', new Response(null, { status: 403 }), {
          method: 'GET',
          headers: { 'authorization': 'Bearer super-secret-upstream-token', 'x-trace': 'abc' },
        })
      })
      app.onError(handleError('test', options))
      return app
    }

    test('opaque mode never serializes the error extras at all', async () => {
      const res = await fetchErrorApp().request('/upstream')
      expect(res.status).toBe(503)
      const text = await res.text()
      expect(text).not.toContain('super-secret-upstream-token')
      expect(text).not.toContain('authorization')
      expect(text).not.toContain('Failed to fetch url')

      const body = JSON.parse(text) as { ok: boolean, error: { code: string, message: string } }
      expect(body.error.code).toBe('FETCH_ERROR')
      expect(body.error.message).toBe('Service unavailable')
    })

    test('detailed mode masks credentials carried on the error', async () => {
      const res = await fetchErrorApp({ exposeDetails: true }).request('/upstream')
      expect(res.status).toBe(503)
      const text = await res.text()
      // The auth header value is masked by redactObject before serialization...
      expect(text).not.toContain('super-secret-upstream-token')
      // ...while non-sensitive detail is preserved for the admin UI.
      expect(text).toContain('Failed to fetch url')
      expect(text).toContain('abc')
    })
  })
})
