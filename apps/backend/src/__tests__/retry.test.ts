import { describe, expect, spyOn, test } from 'bun:test'
import { DownloadsConfig } from '../lib/config'
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

  test('rejects invalid maxAttempts without calling the operation', async () => {
    let calls = 0
    await expect(retry(async () => {
      calls++
      return 'ok'
    }, {
      maxAttempts: 0,
      baseDelayMs: 1,
      maxDelayMs: 10,
      isRetryable: () => true,
      sleep: noSleep,
    })).rejects.toThrow('maxAttempts must be at least 1')
    expect(calls).toBe(0)
  })
})

describe('download retry backoff schedule', () => {
  // The defaults must keep retrying long enough to outlast a ~15-30 min peer
  // outage (the .part stays resumable), so a transient peer restart doesn't
  // terminally fail the download.
  const defaults = DownloadsConfig.parse({ watchPath: '/w', completedPath: '/c' })

  // Drive the real retry() with random()=1 (worst-case full-jitter delay) and
  // a no-op sleep, collecting the delay it would have waited before each retry.
  async function collectMaxDelays(): Promise<number[]> {
    const delays: number[] = []
    await expect(retry(async () => {
      throw new Error('peer unreachable')
    }, {
      maxAttempts: defaults.maxDownloadAttempts,
      baseDelayMs: defaults.retryBaseDelayMs,
      maxDelayMs: defaults.retryMaxDelayMs,
      isRetryable: () => true,
      random: () => 1,
      sleep: async (ms) => {
        delays.push(ms)
      },
    })).rejects.toThrow('peer unreachable')
    return delays
  }

  test('retries enough times to bridge a multi-minute outage', async () => {
    const delays = await collectMaxDelays()
    // maxAttempts total attempts => maxAttempts - 1 retries (one sleep each).
    expect(delays.length).toBe(defaults.maxDownloadAttempts - 1)
  })

  test('worst-case total retry window comfortably exceeds 20 minutes', async () => {
    const delays = await collectMaxDelays()
    const totalMs = delays.reduce((sum, ms) => sum + ms, 0)
    expect(totalMs).toBeGreaterThan(20 * 60 * 1000)
  })

  test('the delay grows exponentially toward the configured max', async () => {
    const delays = await collectMaxDelays()
    // Early retry is small (network-blip friendly).
    expect(delays[0]).toBe(defaults.retryBaseDelayMs)
    // Each subsequent max delay doubles until it saturates at the cap.
    for (let i = 1; i < delays.length; i++)
      expect(delays[i]!).toBe(Math.min(defaults.retryMaxDelayMs, delays[i - 1]! * 2))
    // The latest retries reach the long cap (~30 min) so the schedule spans an outage.
    expect(delays.at(-1)).toBe(defaults.retryMaxDelayMs)
    // At least one retry waits ~15 min (the largest pre-cap step) before saturating.
    const maxBelowCap = Math.max(...delays.filter(ms => ms < defaults.retryMaxDelayMs))
    expect(maxBelowCap).toBeGreaterThanOrEqual(15 * 60 * 1000)
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

  test('treats manual aborts as permanent', () => {
    const abort = new Error('shutting down')
    abort.name = 'AbortError'
    expect(isTransientDownloadError(abort)).toBe(false)
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

  test('parses an HTTP-date Retry-After header', () => {
    const now = Date.UTC(2098, 11, 31, 23, 59, 58)
    const nowSpy = spyOn(Date, 'now').mockReturnValue(now)
    const err = new FetchError('x', new Response(null, { status: 429, headers: { 'Retry-After': 'Thu, 01 Jan 2099 00:00:00 GMT' } }))

    try {
      expect(downloadRetryAfterMs(err)).toBe(2000)
    }
    finally {
      nowSpy.mockRestore()
    }
  })

  test('floors past HTTP-date Retry-After headers at zero', () => {
    const now = Date.UTC(2099, 0, 1, 0, 0, 0)
    const nowSpy = spyOn(Date, 'now').mockReturnValue(now)
    const err = new FetchError('x', new Response(null, { status: 429, headers: { 'Retry-After': 'Wed, 31 Dec 2098 23:59:59 GMT' } }))

    try {
      expect(downloadRetryAfterMs(err)).toBe(0)
    }
    finally {
      nowSpy.mockRestore()
    }
  })

  test('returns null without a header or for non-FetchErrors', () => {
    expect(downloadRetryAfterMs(new FetchError('x', new Response(null, { status: 429 })))).toBeNull()
    expect(downloadRetryAfterMs(new Error('x'))).toBeNull()
  })
})
