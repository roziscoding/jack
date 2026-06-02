import type { ConnectorType } from '../config'
import z from 'zod'
import { logger } from '../../logger'
import { getAppEnvs } from '../envs'
import { FetchError } from '../errors/FetchError'

const DEFAULT_FETCH_TIMEOUT_MS = getAppEnvs().HTTP_TIMEOUT_MS

function generateId(url: string): string {
  const hash = new Bun.CryptoHasher('sha256').update(url).digest('hex')
  return hash.slice(0, 8)
}

export abstract class ServerConnector {
  public readonly id: string
  public readonly type: ConnectorType
  public readonly url: string
  protected readonly apiKey: string
  public readonly name: string

  private readonly pingPath: string
  private readonly pingMethod: string
  private readonly authHeader: string
  private readonly authHeaderPrefix?: string

  protected _isInitialized: boolean = false
  protected _initialization: ReturnType<typeof Promise.withResolvers<void>> | null = null
  protected _initializationError: string | null = null
  protected _initState: 'idle' | 'pending' | 'initialized' | 'failed' = 'idle'

  constructor(connectorConfig: { pingPath: string, pingMethod: string, authHeader: string, authHeaderPrefix?: string }, config: { type: ConnectorType, url: string, apiKey: string, name: string }) {
    this.pingPath = connectorConfig.pingPath
    this.pingMethod = connectorConfig.pingMethod
    this.authHeader = connectorConfig.authHeader
    this.authHeaderPrefix = connectorConfig.authHeaderPrefix ?? ''

    this.id = generateId(config.url)
    this.type = config.type
    this.url = config.url
    this.apiKey = config.apiKey
    this.name = config.name
  }

  get isInitialized() {
    return this._isInitialized
  }

  get initialization() {
    return this._initialization?.promise
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
    logger.debug({ connector: this.name, type: this.type, method, url: url.toString(), timeoutMs }, 'Outgoing request')

    let response: Response
    try {
      response = await fetch(url, initWithAuth)
    }
    catch (err) {
      const timedOut = err instanceof DOMException && err.name === 'TimeoutError'
      logger.warn({ connector: this.name, method, url: url.toString(), timeoutMs, timedOut, err }, timedOut ? `Request timed out after ${timeoutMs}ms` : 'Request failed (network error)')
      throw err
    }

    logger.debug({ connector: this.name, method, url: url.toString(), status: response.status }, 'Response received')

    if (!response.ok) {
      const body = await response.text().catch(() => 'Could not fetch body')
      logger.warn({ connector: this.name, method, url: url.toString(), status: response.status, body }, 'Request failed (non-2xx)')
      throw new FetchError(`Failed to fetch url: ${response.statusText}`, response, { body, method: init.method, headers: initWithAuth.headers })
    }

    const body = await response.json()
    logger.trace({ connector: this.name, method, url: url.pathname, body }, 'Response body')
    if (!init.schema) {
      return body as z.infer<TResponseSchema>
    }

    const { success, error, data } = init.schema.safeParse(body)

    if (!success) {
      logger.warn({ connector: this.name, method, url: url.pathname, error: z.prettifyError(error) }, 'Response failed schema validation')
      throw new FetchError(`Invalid response from ${this.name} when fetching ${init.method ?? 'GET'} ${url.pathname}: ${z.prettifyError(error)}`, response, { body: JSON.stringify(body), method: init.method })
    }

    return data
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

    this.runInit()
      .then(() => {
        this._isInitialized = true
        this._initState = 'initialized'
        this._initialization?.resolve()
      })
      .catch((err: unknown) => {
        this._initializationError = err instanceof Error ? err.message : String(err)
        this._initState = 'failed'
        this._initialization?.reject(err)
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
