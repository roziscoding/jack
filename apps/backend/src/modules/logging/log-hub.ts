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
   * The most recent `lines` records, oldest→newest, optionally keeping only those
   * at or above `minLevel` (pino numeric level). Reads the active file and, if it
   * doesn't yet hold enough lines (e.g. just after a rotation), walks back through
   * the rotated siblings `.1`, `.2`, … so retained history isn't silently dropped.
   * Persists across restarts because the files live on a persistent volume.
   */
  async backfill({ lines, minLevel }: { lines: number, minLevel?: number }): Promise<LogRecord[]> {
    // Fail closed: when a level floor is set, a record must carry a numeric level
    // at or above it — a missing/malformed level is excluded, not let through.
    const passesLevel = (record: LogRecord): boolean =>
      minLevel == null || (typeof record.level === 'number' && record.level >= minLevel)

    let collected: LogRecord[] = []
    // i = 0 is the active file; i > 0 are the successively older rotated files.
    // Each rotated file is entirely older than the previous, so prepend its records.
    for (let i = 0; i < 1000 && collected.length < lines; i++) {
      const path = i === 0 ? this.filePath : `${this.filePath}.${i}`
      const file = Bun.file(path)
      if (!(await file.exists()))
        break
      const records: LogRecord[] = []
      for (const raw of (await file.text()).split('\n')) {
        if (!raw)
          continue
        let record: LogRecord
        try {
          record = JSON.parse(raw) as LogRecord
        }
        catch {
          continue
        }
        if (passesLevel(record))
          records.push(record)
      }
      collected = records.concat(collected)
    }
    return collected.slice(-lines)
  }
}
