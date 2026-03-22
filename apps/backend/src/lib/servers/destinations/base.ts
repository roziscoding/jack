import type { DestinationServerType } from '../../config'
import z from 'zod'
import { logger } from '../../../logger'
import { requireInitialization } from '../../decorators/require-initialization'
import { ServerConnector } from '../base'

export const DestinationServerHealthIssue = z.array(
  z.object({
    id: z.number().int().optional(),
    source: z.string().nullable().optional(),
    type: z.enum(['ok', 'notice', 'warning', 'error']).optional(),
    message: z.string().nullable().optional(),
    wikiUrl: z
      .object({
        fullUri: z.string().nullable().optional(),
        scheme: z.string().nullable().optional(),
        host: z.string().nullable().optional(),
        port: z.number().int().nullable().optional(),
        path: z.string().nullable().optional(),
        query: z.string().nullable().optional(),
        fragment: z.string().nullable().optional(),
      })
      .optional(),
  }),
)

export class DestinationServerConnector extends ServerConnector {
  protected readonly expectedAppName: string

  constructor(connectorConfig: { pingPath: string, pingMethod: string, authHeader: string, authHeaderPrefix?: string, expectedAppName: string }, config: { type: DestinationServerType, url: string, apiKey: string, name?: string }) {
    super(connectorConfig, config)
    this.expectedAppName = connectorConfig.expectedAppName
  }

  override init(): void {
    this._initialization = Promise.withResolvers()

    this.ping(z.object({ appName: z.string(), version: z.string() }))
      .then((apiInfo) => {
        if (apiInfo.appName !== this.expectedAppName) {
          this._initialization?.reject(new Error(`Invalid appName "${apiInfo.appName}" found for server type ${this.type}. Expected ${this.expectedAppName}`))
          return
        }
        
        logger.debug({ apiInfo }, `Found ${apiInfo.appName} ${apiInfo.version}`)
        this._initialization?.resolve()
        this._isInitialized = true
      })
      .catch((err) => {
        const message = err instanceof Error ? err.message : String(err)
        this._initializationError = message
        this._initialization?.reject(err)
      })
  }

  @requireInitialization
  async getHealthIssues() {
    return this.fetch('/api/v3/health', { schema: z.array(DestinationServerHealthIssue) })
  }
}
