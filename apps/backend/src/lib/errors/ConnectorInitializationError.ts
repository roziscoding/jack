import { AppError } from './AppError'

/**
 * A connector failed its connectivity/identity check during an *interactive* add
 * (e.g. the management UI). Unlike a boot-time init failure — which is swallowed so
 * the connector stays resident and auto-retries — this is thrown so the API can
 * report the cause back to the caller (who can fix the url/key and retry) instead
 * of silently persisting a peer that never connected.
 */
export class ConnectorInitializationError extends AppError {
  constructor(message: string, cause?: unknown) {
    super(message, 'CONNECTOR_INITIALIZATION_FAILED', { cause })
  }
}
