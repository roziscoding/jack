import type { LogHub, LogRecord, LogSubscriber } from './log-hub'

export const LOG_LEVEL_VALUES = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
} as const

export type LogLevelName = keyof typeof LOG_LEVEL_VALUES

export class LogsController {
  constructor(private readonly hub: LogHub) {}

  /** Numeric pino level for a name, or undefined (no filter). */
  minLevelFor(level?: LogLevelName): number | undefined {
    return level ? LOG_LEVEL_VALUES[level] : undefined
  }

  backfill(params: { lines: number, level?: LogLevelName }): Promise<LogRecord[]> {
    return this.hub.backfill({ lines: params.lines, minLevel: this.minLevelFor(params.level) })
  }

  subscribe(subscriber: LogSubscriber): () => void {
    return this.hub.subscribe(subscriber)
  }
}
