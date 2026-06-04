import type { AttributeValue, Span } from '@opentelemetry/api'
import type { Context } from 'hono'
import { trace } from '@opentelemetry/api'
import { createMiddleware } from 'hono/factory'
import { redactIfSensitive, redactRecord } from '../lib/redact'
import { logger } from '../logger'

const MAX_CAPTURED_BODY_BYTES = 8 * 1024
const OMITTED_BINARY_BODY = '[binary body omitted]'
const UNREADABLE_BODY = '[unreadable]'

const FLATTENED_HEADER_FIELDS = new Set([
  'accept',
  'content-length',
  'content-type',
  'host',
  'user-agent',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
])
const FLATTENED_QUERY_FIELDS = new Set([
  'cat',
  'ep',
  'extended',
  'imdbid',
  'limit',
  'offset',
  'q',
  'season',
  't',
  'tmdbid',
  'tvdbid',
])

interface CapturedBody {
  text: string
  truncated: boolean
  readable: boolean
  omitted: boolean
  size: string
}

function headersToRecord(headers: Headers): Record<string, string> {
  return Object.fromEntries(headers.entries())
}

function queryToRecord(url: string): Record<string, string | string[]> {
  const params = new URL(url).searchParams
  const record: Record<string, string | string[]> = {}

  for (const key of params.keys()) {
    const values = params.getAll(key)
    record[key] = values.length > 1 ? values : values[0] ?? ''
  }

  return record
}

function isTextualContentType(contentType: string) {
  const normalized = contentType.toLowerCase()
  return normalized.startsWith('text/')
    || normalized.includes('json')
    || normalized.includes('xml')
    || normalized.includes('form-urlencoded')
}

function jsonAttribute(value: unknown): string {
  return JSON.stringify(value)
}

function flattenedAttributes(prefix: string, record: Record<string, string | string[]>, allowedFields: Set<string>): Record<string, AttributeValue> {
  return Object.fromEntries(
    Object.entries(record)
      .filter(([key]) => allowedFields.has(key.toLowerCase()))
      .map(([key, value]) => [`${prefix}.${key.toLowerCase()}`, redactIfSensitive(key, value)]),
  )
}

function emptyBody(size: string): CapturedBody {
  return { text: '', truncated: false, readable: true, omitted: false, size }
}

function omittedBody(size: string): CapturedBody {
  return { text: OMITTED_BINARY_BODY, truncated: false, readable: true, omitted: true, size }
}

async function readBody(stream: ReadableStream<Uint8Array> | null, size: string, maxBytes = MAX_CAPTURED_BODY_BYTES): Promise<CapturedBody> {
  if (!stream) {
    return emptyBody(size)
  }

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

  return {
    text,
    truncated: !done, // stopped on the cap, not EOF
    readable: true,
    omitted: false,
    size,
  }
}

async function captureBody(body: ReadableStream<Uint8Array> | null, contentType: string, size: string): Promise<CapturedBody> {
  if (!body) {
    return emptyBody(size)
  }

  if (contentType && !isTextualContentType(contentType)) {
    return omittedBody(size)
  }

  return readBody(body, size)
    .catch(() => ({ text: UNREADABLE_BODY, truncated: false, readable: false, omitted: false, size }))
}

async function captureRequestBody(ctx: Context): Promise<CapturedBody | undefined> {
  if (!ctx.req.header('content-length') && !ctx.req.header('transfer-encoding')) {
    return undefined
  }

  const contentType = ctx.req.header('content-type') ?? ''
  const size = ctx.req.header('content-length') ?? 'unknown'
  if (contentType && !isTextualContentType(contentType)) {
    return omittedBody(size)
  }

  return captureBody(
    ctx.req.raw.clone().body,
    contentType,
    size,
  )
}

async function captureResponseBody(ctx: Context): Promise<CapturedBody> {
  const contentType = ctx.res.headers.get('content-type') ?? ''
  const size = ctx.res.headers.get('content-length') ?? 'unknown'
  if (contentType && !isTextualContentType(contentType)) {
    return omittedBody(size)
  }

  return captureBody(
    ctx.res.clone().body,
    contentType,
    size,
  )
}

function bodyAttributes(prefix: string, body: CapturedBody | undefined): Record<string, AttributeValue> {
  if (!body) {
    return {}
  }

  return {
    [`${prefix}.body`]: body.text,
    [`${prefix}.body.truncated`]: body.truncated,
    [`${prefix}.body.readable`]: body.readable,
    [`${prefix}.body.omitted`]: body.omitted,
    [`${prefix}.body.size`]: body.size,
  }
}

async function addHttpSpanAttributes(span: Span, ctx: Context, durationMs: number, requestBody: CapturedBody | undefined) {
  const url = new URL(ctx.req.url)
  const responseBody = await captureResponseBody(ctx)
  const requestHeaders = redactRecord(ctx.req.header())
  const requestQuery = redactRecord(queryToRecord(ctx.req.url))
  const responseHeaders = redactRecord(headersToRecord(ctx.res.headers))

  span.setAttributes({
    'http.request.method': ctx.req.method,
    'http.request.path': ctx.req.path,
    'http.request.url': ctx.req.url,
    'http.request.query': jsonAttribute(requestQuery),
    'http.request.headers': jsonAttribute(requestHeaders),
    'http.request.content_type': ctx.req.header('content-type') ?? '',
    'http.request.content_length': ctx.req.header('content-length') ?? '',
    'http.response.status_code': ctx.res.status,
    'http.response.headers': jsonAttribute(responseHeaders),
    'http.response.content_type': ctx.res.headers.get('content-type') ?? '',
    'http.response.content_length': ctx.res.headers.get('content-length') ?? '',
    'http.server.duration_ms': durationMs,
    'url.path': url.pathname,
    'url.query': jsonAttribute(requestQuery),
    ...flattenedAttributes('http.request.header', requestHeaders, FLATTENED_HEADER_FIELDS),
    ...flattenedAttributes('http.request.query', requestQuery, FLATTENED_QUERY_FIELDS),
    ...flattenedAttributes('http.response.header', responseHeaders, FLATTENED_HEADER_FIELDS),
    ...bodyAttributes('http.request', requestBody),
    ...bodyAttributes('http.response', responseBody),
  })
}

export const logRequests = createMiddleware(async (ctx, next) => {
  const span = trace.getActiveSpan()
  const start = performance.now()
  const requestBody = span ? await captureRequestBody(ctx) : undefined
  await next()
  const durationMs = Math.round((performance.now() - start) * 100) / 100

  if (span) {
    await addHttpSpanAttributes(span, ctx, durationMs, requestBody)
  }

  const logObject = {
    http: {
      request: {
        method: ctx.req.method,
        path: ctx.req.path,
      },
      response: {
        status: ctx.res.status,
      },
    },
    durationMs,
  }

  logger.trace(logObject, 'Request completed')
})
