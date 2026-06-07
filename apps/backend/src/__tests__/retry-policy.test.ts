import { describe, expect, test } from 'bun:test'
import { IdleTimeoutError } from '../lib/errors/IdleTimeoutError'
import { IncompleteDownloadError } from '../lib/errors/IncompleteDownloadError'
import { isTransientDownloadError } from '../modules/downloads/retry-policy'

describe('isTransientDownloadError', () => {
  test('IdleTimeoutError is transient (retryable)', () => {
    expect(isTransientDownloadError(new IdleTimeoutError('stalled'))).toBe(true)
  })

  test('IncompleteDownloadError is transient (retryable)', () => {
    expect(isTransientDownloadError(new IncompleteDownloadError('short'))).toBe(true)
  })

  test('a plain AbortError (manual cancel, not idle) is not transient', () => {
    expect(isTransientDownloadError(new DOMException('aborted', 'AbortError'))).toBe(false)
  })
})
