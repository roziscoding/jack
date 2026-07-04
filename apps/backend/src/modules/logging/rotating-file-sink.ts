import { Buffer } from 'node:buffer'
import { closeSync, existsSync, mkdirSync, openSync, renameSync, statSync, unlinkSync, writeSync } from 'node:fs'
import { dirname } from 'node:path'

export interface RotatingFileSinkOptions {
  /** Absolute path of the active log file; rotated files are `${path}.1`, `${path}.2`, … */
  path: string
  /** Rotate once the active file reaches this many bytes. */
  maxBytes: number
  /** Keep this many rotated files (plus the active one); older ones are pruned. */
  maxFiles: number
}

/**
 * A synchronous, in-process pino `multistream` destination that appends NDJSON to
 * a file and rotates it by size — no worker thread (which thread-stream transports
 * don't survive under Bun) and no external logrotate. On reaching `maxBytes` the
 * active file is renamed to `${path}.1`, the existing `${path}.N` shift up by one,
 * and anything past `maxFiles` is pruned. The active path is stable, so the
 * management API's backfill always reads the same file.
 */
export class RotatingFileSink {
  private fd: number
  private bytes: number

  constructor(private readonly options: RotatingFileSinkOptions) {
    mkdirSync(dirname(options.path), { recursive: true })
    this.fd = openSync(options.path, 'a')
    this.bytes = existsSync(options.path) ? statSync(options.path).size : 0
  }

  /** pino calls this with the already-serialized (and redacted) NDJSON line. */
  write(line: string): void {
    const buffer = Buffer.from(line)
    // Rotate before the write that would overflow, so every file stays within
    // maxBytes and the overflowing line lands whole in the fresh file. The
    // `bytes > 0` guard lets a single line larger than maxBytes still be written
    // (to an otherwise-empty file) instead of rotating forever.
    if (this.bytes > 0 && this.bytes + buffer.byteLength > this.options.maxBytes)
      this.rotate()
    try {
      writeSync(this.fd, buffer)
    }
    catch {
      // A logging IO error must never crash the app or the log call.
      return
    }
    this.bytes += buffer.byteLength
  }

  private rotate(): void {
    const { path, maxFiles } = this.options
    try {
      closeSync(this.fd)

      if (maxFiles <= 0) {
        // Keep no history: reopen with 'w' to truncate the active file.
        this.fd = openSync(path, 'w')
        this.bytes = 0
        return
      }

      const oldest = `${path}.${maxFiles}`
      if (existsSync(oldest))
        unlinkSync(oldest)
      for (let i = maxFiles - 1; i >= 1; i--) {
        const src = `${path}.${i}`
        if (existsSync(src))
          renameSync(src, `${path}.${i + 1}`)
      }
      renameSync(path, `${path}.1`)

      this.fd = openSync(path, 'a')
      this.bytes = 0
    }
    catch {
      // If rotation fails, reopen the active file so logging can continue.
      try {
        this.fd = openSync(path, 'a')
        this.bytes = existsSync(path) ? statSync(path).size : 0
      }
      catch {
        // Nothing more we can safely do; drop further writes rather than throw.
      }
    }
  }

  close(): void {
    try {
      closeSync(this.fd)
    }
    catch {
      // best effort
    }
  }
}
