// BFF proxy: every UI data call goes through here. It injects the management key
// (from env or the sealed cookie), enforces same-origin on mutations, and mirrors
// the upstream status + body back to the browser. The browser never sees the key.
export default defineEventHandler(async (event) => {
  const method = event.method
  const isMutation = method !== 'GET' && method !== 'HEAD'

  if (isMutation)
    assertSameOrigin(event)

  const { key } = await resolveKey(event)
  if (!key)
    throw createError({ statusCode: 401, statusMessage: 'not authenticated' })

  const path = event.context.params?.path ?? ''
  const search = getRequestURL(event).search
  const target = upstreamUrl(event, `/${path}${search}`)

  const headers: Record<string, string> = { 'X-Management-Key': key }
  let body: BodyInit | undefined
  if (isMutation) {
    const raw = await readRawBody(event, false)
    if (raw) {
      body = new Uint8Array(raw)
      headers['content-type'] = getRequestHeader(event, 'content-type') ?? 'application/json'
    }
  }

  let res: Response
  const upstreamAbort = new AbortController()
  event.node.res.once('close', () => upstreamAbort.abort())
  try {
    res = await fetch(target, { method, headers, body, signal: upstreamAbort.signal })
  }
  catch {
    throw createError({ statusCode: 503, statusMessage: 'management API is unreachable' })
  }

  setResponseStatus(event, res.status)
  for (const header of ['content-type', 'cache-control', 'x-accel-buffering']) {
    const value = res.headers.get(header)
    if (value)
      setResponseHeader(event, header, value)
  }

  return res.body
})
