import z from 'zod'
import { DestinationServerConnector } from './base'

export class SonarrServerConnector extends DestinationServerConnector {
  constructor(config: { url: string, apiKey: string, name?: string }) {
    super({
      pingPath: '/api/v3/system/status',
      pingMethod: 'GET',
      authHeader: 'X-Api-Key',
      expectedAppName: 'Sonarr',
    }, { ...config, type: 'sonarr' })
  }
}
