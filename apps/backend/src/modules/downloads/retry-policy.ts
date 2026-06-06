import { FetchError } from '../../lib/errors/FetchError'
import { IncompleteDownloadError } from '../../lib/errors/IncompleteDownloadError'

/**
 * Transient = worth retrying: network failures, timeouts, HTTP 5xx, 429, and a
 * truncated stream (the .part is preserved, so a retry resumes). Non-429 4xx and
 * any other error (unsafe filename, file-too-large) are permanent (not retried).
 */
export function isTransientDownloadError(error: unknown): boolean {
  if (error instanceof IncompleteDownloadError)
    return true
  if (error instanceof FetchError) {
    const status = error.response?.status ?? error.extras.status
    if (status == null)
      return true
    if (status === 429)
      return true
    return status >= 500 && status <= 599
  }
  if (error instanceof Error) {
    // AbortSignal.timeout rejects with a TimeoutError; manual aborts are permanent.
    if (error.name === 'TimeoutError')
      return true
    // A failed fetch (DNS, connection refused, reset) rejects with a TypeError.
    if (error instanceof TypeError)
      return true
  }
  return false
}

/** Milliseconds to wait per a 429 `Retry-After` header (seconds or HTTP-date), or null. */
export function downloadRetryAfterMs(error: unknown): number | null {
  if (!(error instanceof FetchError))
    return null
  const header = error.response?.headers?.get('Retry-After')
  if (!header)
    return null
  const seconds = Number(header)
  if (Number.isFinite(seconds))
    return Math.max(0, seconds * 1000)
  const dateMs = Date.parse(header)
  if (!Number.isNaN(dateMs))
    return Math.max(0, dateMs - Date.now())
  return null
}
