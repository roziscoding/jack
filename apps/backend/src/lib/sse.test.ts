import { describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { streamSnapshots } from './sse'

async function readUntil(reader: ReadableStreamDefaultReader<Uint8Array>, expected: string): Promise<string> {
  const decoder = new TextDecoder()
  let buffer = ''
  for (let i = 0; i < 20 && !buffer.includes(expected); i++) {
    const { value, done } = await reader.read()
    if (done)
      break
    buffer += decoder.decode(value, { stream: true })
  }
  return buffer
}

describe('streamSnapshots', () => {
  test('pushes changes immediately and emits periodic heartbeat', async () => {
    let value = 0
    let publish = () => {}
    const app = new Hono().get('/stream', c => streamSnapshots(
      c,
      () => ({ value }),
      (subscriber) => {
        publish = subscriber
        return () => {}
      },
      40,
    ))
    const ac = new AbortController()
    const response = await app.request('/stream', { signal: ac.signal })
    const reader = response.body!.getReader() as unknown as ReadableStreamDefaultReader<Uint8Array>

    try {
      expect(await readUntil(reader, '"value":0')).toContain('"value":0')

      value = 1
      publish()
      const update = await readUntil(reader, '"value":1')
      expect(update).toContain('"value":1')

      const heartbeat = await readUntil(reader, 'event: ping')
      expect(heartbeat).toContain('event: ping')
    }
    finally {
      await reader.cancel().catch(() => {})
      ac.abort()
    }
  })

  test('disconnects a slow consumer instead of buffering snapshots without a bound', async () => {
    let notify: (() => void) | undefined
    let unsubscribed = false
    const app = new Hono().get('/stream', c => streamSnapshots(
      c,
      () => ({ ok: true }),
      (subscriber) => {
        notify = subscriber
        return () => {
          unsubscribed = true
        }
      },
      1000,
    ))

    const response = await app.request('/stream')
    expect(response.status).toBe(200)

    for (let i = 0; i < 20; i++)
      notify!()
    await Bun.sleep(0)

    expect(unsubscribed).toBe(true)
    await response.body?.cancel().catch(() => {})
  })
})
