export interface LogRecord {
  time?: number
  level?: number
  severity?: string
  message?: string
  trace_id?: string
  [key: string]: unknown
}

export type LogSubscriber = (record: LogRecord) => void

/**
 * The live/history fan-out for logs. It doubles as a pino `multistream`
 * destination: every serialized line is parsed and pushed to current SSE
 * subscribers (live tail), while `backfill` reads the persisted rotating file for
 * the initial "last N lines". Live delivery therefore never tails the file, so it
 * is oblivious to rotation.
 */
export class LogHub {
  private readonly subscribers = new Set<LogSubscriber>()

  constructor(private readonly filePath: string) {}

  /** pino `multistream` destination: parse each finished line and fan out live. */
  write(line: string): void {
    if (this.subscribers.size === 0)
      return
    let record: LogRecord
    try {
      record = JSON.parse(line) as LogRecord
    }
    catch {
      return
    }
    for (const subscriber of this.subscribers) {
      try {
        subscriber(record)
      }
      catch {
        // A failing subscriber must not break logging or the other subscribers.
      }
    }
  }

  subscribe(subscriber: LogSubscriber): () => void {
    this.subscribers.add(subscriber)
    return () => {
      this.subscribers.delete(subscriber)
    }
  }

  /** Live subscriber count — exposed for tests/metrics. */
  get subscriberCount(): number {
    return this.subscribers.size
  }

  /**
   * The most recent `lines` records from the persisted file, oldest→newest,
   * optionally dropping anything below `minLevel` (pino numeric level). Reads the
   * active file only (size-capped by rotation), which still holds recent history
   * across restarts because the file is on a persistent volume.
   */
  async backfill({ lines, minLevel }: { lines: number, minLevel?: number }): Promise<LogRecord[]> {
    const file = Bun.file(this.filePath)
    if (!(await file.exists()))
      return []
    const text = await file.text()
    const records: LogRecord[] = []
    for (const raw of text.split('\n')) {
      if (!raw)
        continue
      let record: LogRecord
      try {
        record = JSON.parse(raw) as LogRecord
      }
      catch {
        continue
      }
      if (minLevel != null && typeof record.level === 'number' && record.level < minLevel)
        continue
      records.push(record)
    }
    return records.slice(-lines)
  }
}
