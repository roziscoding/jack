import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { LogHub } from './log-hub'
import { LogsController } from './logs.controller'
import { getLogsRouter } from './logs.router'

let dir: string
let path: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'jack-logsrouter-'))
  path = join(dir, 'jack.ndjson')
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

function router(hub: LogHub) {
  return getLogsRouter(new LogsController(hub))
}

describe('logs router — backfill', () => {
  test('GET / returns the last N records, level-filtered', async () => {
    await writeFile(path, `${[
      { level: 30, message: 'info' },
      { level: 40, message: 'warn' },
      { level: 50, message: 'error' },
    ].map(r => JSON.stringify(r)).join('\n')}\n`)

    const res = await router(new LogHub(path)).request('/?lines=10&level=warn')
    expect(res.status).toBe(200)
    const body = await res.json() as { logs: Array<{ message: string }> }
    expect(body.logs.map(l => l.message)).toEqual(['warn', 'error'])
  })

  test('GET / defaults to 200 lines and rejects an over-cap request', async () => {
    await writeFile(path, `${JSON.stringify({ level: 30, message: 'x' })}\n`)
    const app = router(new LogHub(path))

    expect((await app.request('/')).status).toBe(200)
    // lines is capped at 5000 by the schema.
    expect((await app.request('/?lines=99999')).status).toBe(400)
  })
})

describe('logs router — SSE stream', () => {
  test('streams new records live and honors the level filter', async () => {
    const hub = new LogHub(path)
    const app = router(hub)
    const ac = new AbortController()

    const res = await app.request('/stream?level=warn', { signal: ac.signal })
    expect(res.headers.get('content-type')).toContain('text/event-stream')

    const reader = res.body!.getReader()
    const decoder = new TextDecoder()
    try {
      // The stream opens with a comment so the first body byte (and thus the
      // response headers) flush at t=0 instead of waiting for the first event —
      // otherwise a reverse proxy in front stalls on an idle stream.
      const first = await reader.read()
      expect(decoder.decode(first.value, { stream: true })).toMatch(/^:/)

      // Wait until the endpoint has subscribed before emitting.
      for (let i = 0; i < 100 && hub.subscriberCount === 0; i++)
        await Bun.sleep(10)
      expect(hub.subscriberCount).toBe(1)

      hub.write(`${JSON.stringify({ level: 20, message: 'below-floor' })}\n`) // filtered out
      hub.write(`${JSON.stringify({ level: 50, message: 'boom' })}\n`) // delivered

      let buffer = ''
      for (let i = 0; i < 20 && !buffer.includes('boom'); i++) {
        const { value, done } = await reader.read()
        if (done)
          break
        buffer += decoder.decode(value, { stream: true })
      }

      expect(buffer).toContain('boom')
      expect(buffer).not.toContain('below-floor')
    }
    finally {
      await reader.cancel().catch(() => {})
      ac.abort()
    }
  })
})
