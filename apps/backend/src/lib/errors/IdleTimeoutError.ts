import { AppError } from './AppError'

/**
 * A peer download received no bytes for longer than the idle timeout and was
 * aborted. The `.part` is preserved, so this is retryable: the next attempt
 * resumes from where it stalled.
 */
export class IdleTimeoutError extends AppError {
  constructor(message: string, cause?: unknown) {
    super(message, 'IDLE_TIMEOUT', { cause })
  }
}
