import type { LogRecord } from './log-hub'
import type { LogsController } from './logs.controller'
import { Hono } from 'hono'
import { validator as zValidator } from 'hono-openapi'
import { streamSSE } from 'hono/streaming'
import { z } from 'zod'

const LEVEL = z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal'])

const backfillQuery = z.object({
  // Cap the initial page so a large file can't be slurped whole into a response.
  lines: z.coerce.number().int().min(1).max(5000).default(200),
  level: LEVEL.optional(),
})

const streamQuery = z.object({ level: LEVEL.optional() })

// Poll cadence for draining buffered records to the SSE client, and how often to
// emit a keep-alive comment so idle proxies don't drop the connection.
const DRAIN_INTERVAL_MS = 500
const PING_INTERVAL_MS = 15_000
// Bound the per-client buffer if the consumer can't keep up (drop oldest).
const MAX_PENDING = 2000

export function getLogsRouter(controller: LogsController) {
  const app = new Hono()

  // Initial "last N lines" for the log view, oldest→newest, optional level floor.
  app.get('/', zValidator('query', backfillQuery), async (c) => {
    const { lines, level } = c.req.valid('query')
    return c.json({ logs: await controller.backfill({ lines, level }) })
  })

  // Live tail as Server-Sent Events. Each event's `data` is one NDJSON log record.
  app.get('/stream', zValidator('query', streamQuery), (c) => {
    const { level } = c.req.valid('query')
    const minLevel = controller.minLevelFor(level)

    return streamSSE(c, async (stream) => {
      const pending: LogRecord[] = []
      const unsubscribe = controller.subscribe((record) => {
        if (minLevel != null && typeof record.level === 'number' && record.level < minLevel)
          return
        pending.push(record)
        if (pending.length > MAX_PENDING)
          pending.shift()
      })

      stream.onAbort(unsubscribe)

      try {
        let sincePingMs = 0
        while (!stream.aborted) {
          while (pending.length > 0)
            await stream.writeSSE({ data: JSON.stringify(pending.shift()) })

          await stream.sleep(DRAIN_INTERVAL_MS)
          sincePingMs += DRAIN_INTERVAL_MS
          if (sincePingMs >= PING_INTERVAL_MS) {
            sincePingMs = 0
            await stream.writeSSE({ event: 'ping', data: '' })
          }
        }
      }
      finally {
        unsubscribe()
      }
    })
  })

  return app
}
