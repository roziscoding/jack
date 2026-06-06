import { describe, expect, test } from 'bun:test'
import { FetchError } from '../lib/errors/FetchError'
import { IncompleteDownloadError } from '../lib/errors/IncompleteDownloadError'
import { retry } from '../lib/retry'
import { downloadRetryAfterMs, isTransientDownloadError } from '../modules/downloads/retry-policy'

async function noSleep() {}

describe('retry', () => {
  test('returns immediately on first success', async () => {
    let calls = 0
    const result = await retry(async () => {
      calls++
      return 'ok'
    }, {
      maxAttempts: 3,
      baseDelayMs: 1,
      maxDelayMs: 10,
      isRetryable: () => true,
      sleep: noSleep,
    })
    expect(result).toBe('ok')
    expect(calls).toBe(1)
  })

  test('retries a retryable failure then succeeds', async () => {
    let calls = 0
    const result = await retry(async () => {
      calls++
      if (calls < 2)
        throw new Error('boom')
      return 'ok'
    }, { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 10, isRetryable: () => true, sleep: noSleep, random: () => 1 })
    expect(result).toBe('ok')
    expect(calls).toBe(2)
  })

  test('does not retry a non-retryable error', async () => {
    let calls = 0
    await expect(retry(async () => {
      calls++
      throw new Error('nope')
    }, {
      maxAttempts: 3,
      baseDelayMs: 1,
      maxDelayMs: 10,
      isRetryable: () => false,
      sleep: noSleep,
    })).rejects.toThrow('nope')
    expect(calls).toBe(1)
  })

  test('throws the last error after exhausting attempts', async () => {
    let calls = 0
    await expect(retry(async () => {
      calls++
      throw new Error(`fail-${calls}`)
    }, {
      maxAttempts: 3,
      baseDelayMs: 1,
      maxDelayMs: 10,
      isRetryable: () => true,
      sleep: noSleep,
      random: () => 1,
    })).rejects.toThrow('fail-3')
    expect(calls).toBe(3)
  })

  test('uses retryAfterMs over the jittered backoff', async () => {
    const delays: number[] = []
    let calls = 0
    await retry(async () => {
      calls++
      if (calls < 2)
        throw new Error('429')
      return 'ok'
    }, {
      maxAttempts: 3,
      baseDelayMs: 1,
      maxDelayMs: 10_000,
      isRetryable: () => true,
      retryAfterMs: () => 2000,
      sleep: async (ms) => {
        delays.push(ms)
      },
      random: () => 1,
    })
    expect(delays).toEqual([2000])
  })
})

describe('isTransientDownloadError', () => {
  function fetchError(status: number, headers?: Record<string, string>) {
    return new FetchError('x', new Response(null, { status, headers }))
  }

  test('treats 5xx and 429 as transient', () => {
    expect(isTransientDownloadError(fetchError(500))).toBe(true)
    expect(isTransientDownloadError(fetchError(503))).toBe(true)
    expect(isTransientDownloadError(fetchError(429))).toBe(true)
  })

  test('treats non-429 4xx as permanent', () => {
    expect(isTransientDownloadError(fetchError(400))).toBe(false)
    expect(isTransientDownloadError(fetchError(404))).toBe(false)
  })

  test('treats timeouts and network TypeErrors as transient', () => {
    const timeout = new Error('timed out')
    timeout.name = 'TimeoutError'
    expect(isTransientDownloadError(timeout)).toBe(true)
    expect(isTransientDownloadError(new TypeError('fetch failed'))).toBe(true)
  })

  test('treats an incomplete download as transient', () => {
    expect(isTransientDownloadError(new IncompleteDownloadError('got 3 bytes, expected 5'))).toBe(true)
  })

  test('treats other plain errors as permanent', () => {
    expect(isTransientDownloadError(new Error('Unsafe release filename from peer'))).toBe(false)
  })
})

describe('downloadRetryAfterMs', () => {
  test('parses a seconds Retry-After header', () => {
    const err = new FetchError('x', new Response(null, { status: 429, headers: { 'Retry-After': '2' } }))
    expect(downloadRetryAfterMs(err)).toBe(2000)
  })

  test('returns null without a header or for non-FetchErrors', () => {
    expect(downloadRetryAfterMs(new FetchError('x', new Response(null, { status: 429 })))).toBeNull()
    expect(downloadRetryAfterMs(new Error('x'))).toBeNull()
  })
})
