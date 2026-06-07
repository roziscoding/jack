import { AppError } from './AppError'

/**
 * A peer reported a peer-protocol version we can't talk to — or is too old to
 * report one at all. Thrown during init so the connector fails loudly and the
 * mismatch surfaces in /servers (initialized:false + initializationError).
 */
export class IncompatiblePeerError extends AppError {
  constructor(message: string, cause?: unknown) {
    super(message, 'INCOMPATIBLE_PEER', { cause })
  }
}
