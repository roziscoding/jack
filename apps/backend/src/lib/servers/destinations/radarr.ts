import { DestinationServerConnector } from './base'

export class RadarrServerConnector extends DestinationServerConnector {
  constructor(config: { url: string, apiKey: string, name?: string }) {
    super({
      pingPath: '/api/v3/system/status',
      pingMethod: 'GET',
      authHeader: 'X-Api-Key',
      expectedAppName: 'Radarr',
    }, { ...config, type: 'radarr' })
  }
}
