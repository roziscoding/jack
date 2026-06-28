import type { ConnectorHeadersConfig, ConnectorType } from '../config'
import z from 'zod'
import { logger } from '../../logger'
import { getAppEnvs } from '../envs'
import { FetchError } from '../errors/FetchError'
import { redactObject, redactRecord } from '../redact'
import { setSpanAttribute, setSpanAttributes } from '../span-attributes'
import { withSpan } from '../tracing'

const DEFAULT_FETCH_TIMEOUT_MS = getAppEnvs().HTTP_TIMEOUT_MS
const MAX_ERROR_BODY_BYTES = 8 * 1024

// Mask sensitive fields in a possibly-JSON upstream body before it becomes a span
// attribute (spans, unlike logs, aren't otherwise scrubbed). Non-JSON bodies pass
// through unchanged.
function redactBody(body: string): string {
  try {
    return JSON.stringify(redactObject(JSON.parse(body)))
  }
  catch {
    return body
  }
}

export function generateId(url: string): string {
  const hash = new Bun.CryptoHasher('sha256').update(url).digest('hex')
  return hash.slice(0, 8)
}

function truncateBody(body: string) {
  if (body.length <= MAX_ERROR_BODY_BYTES)
    return body
  return `${body.slice(0, MAX_ERROR_BODY_BYTES)}...`
}

export abstract class ServerConnector {
  public readonly id: string
  public readonly name: string
  public readonly type: ConnectorType
  public readonly url: string
  protected readonly apiKey: string
  protected readonly headers: ConnectorHeadersConfig
  protected _enabled: boolean = true

  private readonly pingPath: string
  private readonly pingMethod: string
  private readonly authHeader: string
  private readonly authHeaderPrefix?: string

  protected _isInitialized: boolean = false
  protected _initialization: ReturnType<typeof Promise.withResolvers<void>> = Promise.withResolvers()
  protected _initializationError: string | null = null
  protected _initState: 'idle' | 'pending' | 'initialized' | 'failed' = 'idle'

  constructor(connectorConfig: { pingPath: string, pingMethod: string, authHeader: string, authHeaderPrefix?: string }, config: { url: string, name: string, apiKey: string, type: ConnectorType, headers?: ConnectorHeadersConfig }) {
    this.pingPath = connectorConfig.pingPath
    this.pingMethod = connectorConfig.pingMethod
    this.authHeader = connectorConfig.authHeader
    this.authHeaderPrefix = connectorConfig.authHeaderPrefix ?? ''

    this.id = generateId(config.url)
    this.type = config.type
    this.url = config.url
    this.apiKey = config.apiKey
    this.headers = config.headers ?? {}
    this.name = config.name
  }

  get isInitialized() {
    return this._isInitialized
  }

  get initialization() {
    return this._initialization.promise
  }

  get initializationError() {
    return this._initializationError
  }

  private get authHeaders() {
    const authHeader = this.authHeader
    return {
      [authHeader]: this.authHeaderValue,
    }
  }

  get enabled() {
    return this._enabled
  }

  public disable() {
    this._enabled = false
  }

  public enable() {
    this._enabled = true
  }

  protected get authHeaderValue(): string {
    return `${this.authHeaderPrefix}${this.apiKey}`
  }

  protected async fetch<TResponseSchema extends z.ZodType = z.ZodUnknown>(path: string, init: RequestInit & { schema?: TResponseSchema, query?: Record<string, string>, timeoutMs?: number } = { method: 'GET' }): Promise<z.infer<TResponseSchema>> {
    const timeoutMs = init.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS
    const initWithAuth = {
      ...init,
      // Bound every request so a hung connector can't stall the caller forever.
      // A caller-supplied signal takes precedence over the default timeout.
      signal: init.signal ?? AbortSignal.timeout(timeoutMs),
      headers: {
        ...this.headers,
        ...this.authHeaders,
        ...init?.headers,
      },
    }

    const url = new URL(path, this.url)
    if (init.query) {
      for (const [key, value] of Object.entries(init.query)) {
        url.searchParams.append(key, value)
      }
    }

    const method = init.method ?? 'GET'

    return withSpan('connector.fetch', {
      'connector.name': this.name,
      'connector.type': this.type,
      'http.request.method': method,
      'http.request.timeout_ms': timeoutMs,
      // Mask credentials (X-Api-Key, Cloudflare Access secrets, …) before they're
      // recorded on the span — the same scrub logs already get.
      'http.request.headers': redactRecord(initWithAuth.headers as Record<string, string>),
      'server.address': url.hostname,
      'url.path': url.pathname,
      'url.query': url.search ? url.search.slice(1) : undefined,
    }, async (span) => {
      let response: Response
      try {
        response = await fetch(url, initWithAuth)
      }
      catch (err) {
        const timedOut = err instanceof DOMException && err.name === 'TimeoutError'
        setSpanAttribute(span, 'error.timeout', timedOut)
        logger.warn({ connector: this.name, method, url: url.toString(), timeoutMs, timedOut, err }, timedOut ? `Request timed out after ${timeoutMs}ms` : 'Request failed (network error)')
        throw err
      }

      setSpanAttributes(span, {
        'http.response.status_code': response.status,
        'http.response.content_type': response.headers.get('content-type') ?? '',
        'http.response.content_length': response.headers.get('content-length') ?? '',
      })

      if (!response.ok) {
        const body = await response.text().catch(() => 'Could not fetch body')
        setSpanAttribute(span, 'http.response.body', redactBody(body))
        logger.warn({ connector: this.name, method, url: url.toString(), status: response.status, body: truncateBody(body) }, 'Request failed (non-2xx)')
        throw new FetchError(`Failed to fetch url: ${response.statusText}`, response, { body, method: init.method, headers: initWithAuth.headers })
      }

      const body = await response.json()
      if (!init.schema) {
        return body as z.infer<TResponseSchema>
      }

      const { success, error, data } = init.schema.safeParse(body)

      if (!success) {
        const prettyError = z.prettifyError(error)
        setSpanAttributes(span, {
          'schema.validation.success': false,
          'schema.validation.error': prettyError,
        })
        logger.warn({ connector: this.name, method, url: url.pathname, error: prettyError }, 'Response failed schema validation')
        throw new FetchError(`Invalid response from ${this.name} when fetching ${init.method ?? 'GET'} ${url.pathname}: ${prettyError}`, response, { body: JSON.stringify(body), method: init.method })
      }

      setSpanAttribute(span, 'schema.validation.success', true)
      return data
    })
  }

  async ping<TResponseSchema extends z.ZodType = z.ZodUnknown>(schema?: TResponseSchema): Promise<z.infer<TResponseSchema>> {
    return await this.fetch(this.pingPath, { method: this.pingMethod, schema })
  }

  /**
   * Connect to the server (a connectivity/identity check). Idempotent and
   * retry-aware: it (re)runs the check only when we've never tried, or the last
   * attempt FAILED. While an attempt is in flight, or once it has succeeded, this
   * is a no-op — so callers can call it freely (e.g. `@requireInitialization`
   * does on every guarded call) without re-pinging a healthy or in-progress
   * connector. A connector that was down at boot is therefore re-tried the next
   * time it's used, and rejoins once it's back.
   */
  init() {
    if (this._initState === 'pending' || this._initState === 'initialized') {
      return
    }

    const retrying = this._initState === 'failed'
    const previousError = this._initializationError ?? undefined

    if (this._initState === 'failed') {
      logger.info({ connector: this.name, url: this.url, previousError: this._initializationError }, `Retrying connector "${this.name}" that previously failed to initialize`)
    }

    this._initState = 'pending'
    this._isInitialized = false
    this._initializationError = null
    this._initialization = Promise.withResolvers<void>()
    // Keep an always-present handler so a rejected retry that nobody awaits
    // doesn't surface as an unhandled promise rejection.
    this._initialization.promise.catch(() => {})

    withSpan('server.init', {
      'connector.name': this.name,
      'connector.type': this.type,
      'connector.id': this.id,
      'server.url': this.url,
      'init.retry': retrying,
      'init.previous_error': previousError,
    }, async (span) => {
      await this.runInit()
      setSpanAttribute(span, 'connector.initialized', true)
    })
      .then(() => {
        this._isInitialized = true
        this._initState = 'initialized'
        this._initialization.resolve()
      })
      .catch((err: unknown) => {
        this._initializationError = err instanceof Error ? err.message : String(err)
        this._initState = 'failed'
        this._initialization.reject(err)
      })
  }

  /**
   * The actual connectivity/identity check run by `init()`. Subclasses override
   * to validate the server (e.g. an *arr `appName`); throw to fail initialization.
   */
  protected async runInit(): Promise<void> {
    await this.ping()
  }
}
