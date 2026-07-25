/** A counting semaphore with FIFO fairness for limiting concurrent async work. */
export class Semaphore {
  private available: number
  private readonly waiters: Array<{ resolve: () => void, signal?: AbortSignal, onAbort?: () => void }> = []

  constructor(permits: number) {
    if (!Number.isInteger(permits) || permits < 1)
      throw new Error(`Semaphore permits must be a positive integer, got ${permits}`)
    this.available = permits
  }

  async acquire(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted()
    if (this.available > 0) {
      this.available--
      return
    }
    await new Promise<void>((resolve, reject) => {
      const waiter: { resolve: () => void, signal?: AbortSignal, onAbort?: () => void } = { resolve, signal }
      if (signal) {
        waiter.onAbort = () => {
          const index = this.waiters.indexOf(waiter)
          if (index >= 0)
            this.waiters.splice(index, 1)
          reject(signal.reason)
        }
        signal.addEventListener('abort', waiter.onAbort, { once: true })
      }
      this.waiters.push(waiter)
    })
  }

  release(): void {
    const next = this.waiters.shift()
    if (next) {
      // Hand the permit straight to the next waiter (keeps `available` at 0).
      if (next.signal && next.onAbort)
        next.signal.removeEventListener('abort', next.onAbort)
      next.resolve()
      return
    }
    this.available++
  }

  async run<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    await this.acquire(signal)
    try {
      return await fn()
    }
    finally {
      this.release()
    }
  }
}
