/** A counting semaphore with FIFO fairness for limiting concurrent async work. */
export class Semaphore {
  private available: number
  private readonly waiters: Array<() => void> = []

  constructor(permits: number) {
    if (!Number.isInteger(permits) || permits < 1)
      throw new Error(`Semaphore permits must be a positive integer, got ${permits}`)
    this.available = permits
  }

  async acquire(): Promise<void> {
    if (this.available > 0) {
      this.available--
      return
    }
    await new Promise<void>(resolve => this.waiters.push(resolve))
  }

  release(): void {
    const next = this.waiters.shift()
    if (next) {
      // Hand the permit straight to the next waiter (keeps `available` at 0).
      next()
      return
    }
    this.available++
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire()
    try {
      return await fn()
    }
    finally {
      this.release()
    }
  }
}
