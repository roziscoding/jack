import type { DestinationServerType, ServerType } from '../config'
import z from 'zod'
import { FetchError } from '../errors/FetchError'

export abstract class ServerConnector {
  public readonly type: ServerType
  public readonly url: string
  protected readonly apiKey: string
  public readonly name: string | undefined

  private readonly pingPath: string
  private readonly pingMethod: string
  private readonly authHeader: string
  private readonly authHeaderPrefix?: string

  protected _isInitialized: boolean = false
  protected _initialization: ReturnType<typeof Promise.withResolvers<void>> | null = null
  protected _initializationError: string | null = null

  constructor(connectorConfig: { pingPath: string, pingMethod: string, authHeader: string, authHeaderPrefix?: string }, config: { type: ServerType, url: string, apiKey: string, name?: string }) {
    this.pingPath = connectorConfig.pingPath
    this.pingMethod = connectorConfig.pingMethod
    this.authHeader = connectorConfig.authHeader
    this.authHeaderPrefix = connectorConfig.authHeaderPrefix ?? ''

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

  protected async fetch<TResponseSchema extends z.ZodType = z.ZodUnknown>(path: string, init: RequestInit & { schema?: TResponseSchema, query?: Record<string, string> } = { method: 'GET' }): Promise<z.infer<TResponseSchema>> {
    const initWithAuth = {
      ...init,
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
    const response = await fetch(url, initWithAuth)

    if (!response.ok) {
      const body = await response.text().catch(() => 'Could not fetch body')
      throw new FetchError(`Failed to fetch url: ${response.statusText}`, response, { body, method: init.method, headers: initWithAuth.headers })
    }

    const body = await response.json()
    if (!init.schema) {
      return body as z.infer<TResponseSchema>
    }

    const { success, error, data } = init.schema.safeParse(body)

    if (!success) {
      throw new FetchError(`Invalid response from ${this.name} when fetching ${init.method ?? 'GET'} ${url.pathname}: ${z.prettifyError(error)}`, response, { body: JSON.stringify(body), method: init.method })
    }

    return data
  }

  async ping<TResponseSchema extends z.ZodType = z.ZodUnknown>(schema?: TResponseSchema): Promise<z.infer<TResponseSchema>> {
    return await this.fetch(this.pingPath, { method: this.pingMethod, schema })
  }

  init() {
    if (this.initialization) {
      return
    }

    this._initialization = Promise.withResolvers()
    this.ping()
      .then(() => {
        this._initialization?.resolve()
        this._isInitialized = true
      })
      .catch((err) => {
        const message = err instanceof Error ? err.message : String(err)
        this._initializationError = message
        this._initialization?.reject()
      })
  }
}
