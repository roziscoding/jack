import type { Context } from 'hono'
import { createMiddleware } from 'hono/factory'
import { logger } from '../logger'

const MAX_BODY_BYTES = 500

async function readResponseBody(ctx: Context, maxBytes: number = MAX_BODY_BYTES) {
  const stream = ctx.res.clone().body
  const size = ctx.res.headers.get('content-length') ?? 'unknown'

  if (!stream)
    return { text: '', truncated: false }

  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  let done = false

  try {
    while (!done && total < maxBytes) {
      const r = await reader.read()
      done = r.done
      if (r.value) {
        chunks.push(r.value)
        total += r.value.byteLength
      }
    }
  }
  finally {
    await reader.cancel() // discard the rest, frees our tee buffer
  }

  const buf = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    buf.set(chunk, offset)
    offset += chunk.byteLength
  }

  const text = new TextDecoder().decode(buf.subarray(0, maxBytes))
  const finalText = !done ? `${text}... (${size} bytes total)` : text

  return {
    text: finalText,
    truncated: !done, // stopped on the cap, not EOF
  }
}

async function getResponseBody(ctx: Context) {
  const contentType = ctx.res.headers.get('content-type') ?? ''
  if (contentType.includes('application/octet-stream')) {
    return '[binary stream ommited]'
  }

  const { text, truncated } = await readResponseBody(ctx)
    .catch(() => ({ text: null, truncated: false }))

  if (text === null) {
    return '[unreadable]'
  }

  // Only attempt to parse JSON when we have the whole body — a truncated
  // body isn't valid JSON.
  if (!truncated && contentType.includes('application/json')) {
    try {
      return JSON.parse(text)
    }
    catch (err) {
      logger.trace({ err }, 'Failed to parse response body as JSON. Logging as plain text')
    }
  }

  return text
}

export const logRequests = createMiddleware(async (ctx, next) => {
  const isTracingEnabled = logger.isLevelEnabled('trace')

  const start = performance.now()
  await next()
  const durationMs = Math.round((performance.now() - start) * 100) / 100

  const body = isTracingEnabled ? await getResponseBody(ctx) : undefined
  const logObject = {
    http: {
      request: {
        query: ctx.req.query(),
        headers: ctx.req.header(),
        method: ctx.req.method,
        path: ctx.req.path,
      },
      response: {
        status: ctx.res.status,
        body,
      },
    },
    durationMs,
  }

  if (isTracingEnabled) {
    return logger.trace(logObject)
  }

  logger.debug(logObject)
})
