import type { PeerConfig, ServerConfig } from '../config'
import type { ArrServerConnector } from './arr/base'
import type { ServerConnector } from './base'
import { logger } from '../../logger'
import { RadarrServerConnector } from './arr/radarr'
import { SonarrServerConnector } from './arr/sonarr'
import { generateId } from './base'
import { PeerConnector } from './peer'

const serverConnectorMap = {
  radarr: RadarrServerConnector,
  sonarr: SonarrServerConnector,
} as const

export function getServerConnector(config: ServerConfig): ArrServerConnector {
  const Connector = serverConnectorMap[config.type]
  return new Connector(config)
}

async function initializeConnector(connector: ServerConnector) {
  if (connector.isInitialized)
    return

  connector.init()
  await connector.initialization
    .then(() => {
      logger.debug({ connector: { name: connector.name, url: connector.url } }, `Initialized connector ${connector.name}`)
    })!
    .catch((error) => {
      const message = error instanceof Error ? error.message : String(error)
      logger.error({ error, connector: { name: connector.name, url: connector.url } }, `Failed to initialize connector ${connector.name}: ${message}`)
    })
}
export class ConnectorManager {
  private readonly _serverMap: Map<string, ArrServerConnector> = new Map()
  private readonly _peerMap: Map<string, PeerConnector> = new Map()
  private _destinationIds: string[] = []
  private _sourceIds: string[] = []

  constructor(servers: ServerConfig[], peers: PeerConfig[]) {
    logger.debug('Loading connectors from config')

    for (const serverConfig of servers) {
      const id = generateId(serverConfig.url)
      const connector = getServerConnector(serverConfig)
      this._serverMap.set(id, connector)
      if (connector.canDestination) {
        this._destinationIds.push(connector.id)
      }
      if (connector.canSource) {
        this._sourceIds.push(connector.id)
      }
    }

    logger.debug(`${this._serverMap.size} servers loaded`)

    for (const peerConfig of peers) {
      const id = generateId(peerConfig.url)
      const connector = new PeerConnector(peerConfig)
      this._peerMap.set(id, connector)
    }

    logger.debug(`${this._peerMap.size} peers loaded`)
  }

  private getConnector(id: string): ServerConnector | undefined {
    return this._serverMap.get(id) ?? this._peerMap.get(id)
  }

  public get servers() {
    return this._serverMap.values().toArray().filter(c => c.enabled)
  }

  public get peers() {
    return this._peerMap.values().toArray().filter(c => c.enabled)
  }

  public get destinations() {
    // Also gate on the CURRENT capability so a server toggled destination:false on
    // update (Phase 5) drops out even if its id is still in the list.
    return this._destinationIds
      .map(id => this._serverMap.get(id))
      .filter((c): c is ArrServerConnector => Boolean(c?.enabled && c.canDestination))
  }

  public get sources() {
    return this._sourceIds
      .map(id => this._serverMap.get(id))
      .filter((c): c is ArrServerConnector => Boolean(c?.enabled && c.canSource))
  }

  public get connectors() {
    return [...this._serverMap.values(), ...this._peerMap.values()].filter(c => c.enabled)
  }

  public async initAll() {
    await Promise.allSettled(
      this.connectors.map(async (connector) => {
        logger.info({ connector: { name: connector.name, url: connector.url } }, `Initializing connector ${connector.name}`)
        await initializeConnector(connector)
      }),
    )
  }

  public async addServerConnector(config: ServerConfig) {
    const connector = getServerConnector(config)
    this._serverMap.set(connector.id, connector)

    // Reconcile: drop any prior entry for this id, then re-add per current caps.
    this._destinationIds = this._destinationIds.filter(id => id !== connector.id)
    this._sourceIds = this._sourceIds.filter(id => id !== connector.id)
    if (connector.canDestination)
      this._destinationIds.push(connector.id)
    if (connector.canSource)
      this._sourceIds.push(connector.id)

    await initializeConnector(connector)
  }

  public async addPeerConnector(config: PeerConfig) {
    const connector = new PeerConnector(config)
    this._peerMap.set(connector.id, connector)

    await initializeConnector(connector)
  }

  public removeConnector(id: string) {
    const connector = this.getConnector(id)

    if (!connector) {
      logger.info({ id }, 'Cannot disable connector because it was not found')
      return
    }

    connector.disable()
  }
}
