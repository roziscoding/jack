import { AppError } from './AppError'

/**
 * The peer's stream ended before the expected number of bytes arrived. The
 * `.part` file is preserved, so this is retryable: the next attempt resumes.
 */
export class IncompleteDownloadError extends AppError {
  constructor(message: string, cause?: unknown) {
    super(message, 'INCOMPLETE_DOWNLOAD', { cause })
  }
}
