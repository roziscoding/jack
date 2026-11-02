import { FetchError } from '../../lib/errors/FetchError'
import { FILE_SYSTEM_ERROR_CODES, FileSystemError } from '../../lib/errors/FileSystemError'
import { IdleTimeoutError } from '../../lib/errors/IdleTimeoutError'
import { IncompleteDownloadError } from '../../lib/errors/IncompleteDownloadError'
import { UnknownSizeError } from '../../lib/errors/UnknownSizeError'

/**
 * Why a download ended up `failed`. Stored in `downloads.error_code` and
 * documented in the troubleshooting guide; keep both in sync.
 */
export const DOWNLOAD_ERROR_CODES = [
  ...FILE_SYSTEM_ERROR_CODES,
  'IDLE_TIMEOUT',
  'INCOMPLETE_DOWNLOAD',
  'UNKNOWN_SIZE',
  'PEER_HTTP_ERROR',
  'PEER_UNREACHABLE',
  'PEER_NOT_FOUND',
  'CANCELLED',
  'SUPERSEDED',
  'STALE_AFTER_RESTART',
  'IMPORT_REJECTED',
  'IMPORT_TRIGGER_FAILED',
  'UNKNOWN_ERROR',
] as const
export type DownloadErrorCode = typeof DOWNLOAD_ERROR_CODES[number]

/** The code for an error that ended a transfer. `signal` tells a user cancel apart. */
export function transferErrorCode(err: unknown, signal?: AbortSignal): DownloadErrorCode {
  if (signal?.aborted)
    return 'CANCELLED'
  if (err instanceof FileSystemError || err instanceof IdleTimeoutError || err instanceof IncompleteDownloadError || err instanceof UnknownSizeError)
    return err.code as DownloadErrorCode
  if (err instanceof FetchError) {
    return (err.response?.status ?? err.extras.status) == null
      ? 'PEER_UNREACHABLE'
      : 'PEER_HTTP_ERROR'
  }
  // A failed fetch (DNS, connection refused, reset) rejects with a TypeError;
  // AbortSignal.timeout rejects with a TimeoutError.
  if (err instanceof TypeError || (err instanceof Error && err.name === 'TimeoutError'))
    return 'PEER_UNREACHABLE'
  return 'UNKNOWN_ERROR'
}

/**
 * Log fields for a transfer error. The log message stays generic; the code, a
 * one-line error, and (for filesystem errors) the structured context go here.
 * The download row keeps the full multi-line message instead.
 */
export function transferErrorLogFields(err: unknown, signal?: AbortSignal): Record<string, unknown> {
  const error_code = transferErrorCode(err, signal)
  if (err instanceof FileSystemError)
    return { error_code, error: err.summary, filesystem: err.details }
  return {
    error_code,
    error: err instanceof Error
      ? err.message
      : String(err),
  }
}
