export interface RetryOptions {
  /** Total attempts, including the first. */
  maxAttempts: number
  baseDelayMs: number
  maxDelayMs: number
  /** Whether a thrown error should be retried. */
  isRetryable: (error: unknown) => boolean
  /** Optional explicit delay (e.g. from a Retry-After header), capped at maxDelayMs. */
  retryAfterMs?: (error: unknown) => number | null
  onRetry?: (info: { attempt: number, delayMs: number, error: unknown }) => void
  /** Injectable for tests (defaults to setTimeout). */
  sleep?: (ms: number) => Promise<void>
  /** Injectable for tests (defaults to Math.random). */
  random?: () => number
  /** Cancels both pending backoff delays and subsequent attempts. */
  signal?: AbortSignal
}

const defaultSleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

function abortableDefaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(finish, ms)
    const onAbort = () => finish(signal.reason)
    function finish(error?: unknown) {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      if (error === undefined)
        resolve()
      else
        reject(error)
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

export async function retry<T>(fn: (attempt: number) => Promise<T>, options: RetryOptions): Promise<T> {
  const { maxAttempts, baseDelayMs, maxDelayMs, isRetryable, retryAfterMs, onRetry } = options
  const sleep = options.sleep ?? defaultSleep
  const random = options.random ?? Math.random

  if (!Number.isInteger(maxAttempts) || maxAttempts < 1)
    throw new RangeError('maxAttempts must be at least 1')

  for (let attempt = 1; ; attempt++) {
    try {
      options.signal?.throwIfAborted()
      return await fn(attempt)
    }
    catch (error) {
      if (attempt >= maxAttempts || !isRetryable(error))
        throw error

      const explicit = retryAfterMs?.(error) ?? null
      // Full jitter (AWS): pick uniformly in [0, exponential backoff].
      const backoff = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1))
      const delayMs = explicit != null ? Math.min(explicit, maxDelayMs) : random() * backoff
      onRetry?.({ attempt, delayMs, error })
      if (options.signal && !options.sleep) {
        await abortableDefaultSleep(delayMs, options.signal)
        continue
      }
      const delay = sleep(delayMs)
      if (!options.signal) {
        await delay
        continue
      }
      options.signal.throwIfAborted()
      await new Promise<void>((resolve, reject) => {
        const onAbort = () => reject(options.signal!.reason)
        options.signal!.addEventListener('abort', onAbort, { once: true })
        void delay.then(resolve, reject).finally(() => options.signal!.removeEventListener('abort', onAbort))
      })
    }
  }
}
