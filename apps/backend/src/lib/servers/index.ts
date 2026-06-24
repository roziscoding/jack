import type { PeerConfig, ServerConfig } from '../config'
import type { ArrServerConnector } from './arr/base'
import type { ServerConnector } from './base'
import { logger } from '../../logger'
import { ConnectorInitializationError } from '../errors/ConnectorInitializationError'
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

// `rethrow` controls what happens when the connectivity check fails. Boot-time
// callers (`initAll`) leave it false: a connector that's down should stay resident
// and auto-retry (its `init()` is retry-aware), never crash startup. Interactive
// callers (an add via the management UI) set it true so the failure surfaces to the
// user instead of silently persisting a connector that never connected.
async function initializeConnector(connector: ServerConnector, { rethrow = false }: { rethrow?: boolean } = {}) {
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
      if (rethrow)
        throw error
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

  // `rethrowInitError` makes an interactive add/update atomic: when set, a failed
  // connectivity check restores the live map to exactly its prior state (re-instate a
  // connector this call replaced, or drop a freshly-added one) and throws, so the
  // caller can roll the persisted config back. Left false (boot / non-throwing
  // callers), it keeps the resident-and-retry behavior unchanged.
  public async addServerConnector(config: ServerConfig, { rethrowInitError = false }: { rethrowInitError?: boolean } = {}) {
    const connector = getServerConnector(config)
    // Snapshot the slices this call mutates so a failed init can be undone wholesale.
    const previous = this._serverMap.get(connector.id)
    const prevDestinationIds = [...this._destinationIds]
    const prevSourceIds = [...this._sourceIds]

    this._serverMap.set(connector.id, connector)

    // Reconcile: drop any prior entry for this id, then re-add per current caps.
    this._destinationIds = this._destinationIds.filter(id => id !== connector.id)
    this._sourceIds = this._sourceIds.filter(id => id !== connector.id)
    if (connector.canDestination)
      this._destinationIds.push(connector.id)
    if (connector.canSource)
      this._sourceIds.push(connector.id)

    try {
      await initializeConnector(connector, { rethrow: rethrowInitError })
    }
    catch (err) {
      if (previous)
        this._serverMap.set(connector.id, previous)
      else
        this._serverMap.delete(connector.id)
      this._destinationIds = prevDestinationIds
      this._sourceIds = prevSourceIds
      const message = err instanceof Error ? err.message : String(err)
      throw new ConnectorInitializationError(`Could not connect to server "${connector.name}": ${message}`, err)
    }
  }

  public async addPeerConnector(config: PeerConfig, { rethrowInitError = false }: { rethrowInitError?: boolean } = {}) {
    const connector = new PeerConnector(config)
    const previous = this._peerMap.get(connector.id)
    this._peerMap.set(connector.id, connector)

    try {
      await initializeConnector(connector, { rethrow: rethrowInitError })
    }
    catch (err) {
      // Restore the prior map state: re-instate a connector this update replaced, or
      // drop a freshly-added one, so a failed init leaves the live map untouched.
      if (previous)
        this._peerMap.set(connector.id, previous)
      else
        this._peerMap.delete(connector.id)
      const message = err instanceof Error ? err.message : String(err)
      throw new ConnectorInitializationError(`Could not connect to peer "${connector.name}": ${message}`, err)
    }
  }

  /**
   * Soft-remove a connector: mark it disabled so every fan-out getter skips it, but
   * keep the instance resident so any in-flight download holding its reference can
   * finish on the still-live connector.
   *
   * Trade-off (intentional): disabled connectors are NOT evicted from the maps, so a
   * long-lived process that churns many distinct-URL add/remove cycles accumulates
   * dead connector instances until the next restart (which rebuilds the maps from the
   * file and so prunes them). This is bounded by restart and acceptable for the
   * expected usage (a small, slowly-changing set of peers/servers). If churn ever
   * becomes high-volume, evict here once the connector reports no in-flight transfers.
   */
  public removeConnector(id: string) {
    const connector = this.getConnector(id)

    if (!connector) {
      logger.info({ id }, 'Cannot disable connector because it was not found')
      return
    }

    connector.disable()
  }
}
