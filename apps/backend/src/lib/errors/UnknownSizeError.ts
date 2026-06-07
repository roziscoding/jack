import { AppError } from './AppError'

/**
 * The download has no known expected size (no Content-Length / Content-Range and
 * no releaseSize), so completeness can't be verified. Fail-fast and permanent —
 * retrying won't make a size appear.
 */
export class UnknownSizeError extends AppError {
  constructor(message: string, cause?: unknown) {
    super(message, 'UNKNOWN_SIZE', { cause })
  }
}
