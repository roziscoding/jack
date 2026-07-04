import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { RotatingFileSink } from './rotating-file-sink'

let dir: string
let path: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'jack-logsink-'))
  path = join(dir, 'jack.ndjson')
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

// Each line below is 10 bytes ("012345678\n"), so byte math is easy to reason about.
function line(n: number): string {
  return `${String(n).padStart(8, '0')}\n`
}

describe('RotatingFileSink', () => {
  test('appends lines to the active file until the size threshold', () => {
    const sink = new RotatingFileSink({ path, maxBytes: 1000, maxFiles: 3 })
    sink.write(line(1))
    sink.write(line(2))
    sink.close()

    expect(readFileSync(path, 'utf8')).toBe(line(1) + line(2))
    expect(existsSync(`${path}.1`)).toBe(false)
  })

  test('rotates the active file to .1 before the overflowing write', () => {
    // 10-byte lines, rotate at 15 bytes → the 2nd write would overflow, so it
    // rotates first and the 2nd line lands in the fresh active file.
    const sink = new RotatingFileSink({ path, maxBytes: 15, maxFiles: 3 })
    sink.write(line(1))
    sink.write(line(2)) // 10 + 10 > 15 → rotate first, then write l2
    sink.write(line(3)) // 10 + 10 > 15 → rotate again
    sink.close()

    // Each file holds exactly one line; every file stays within maxBytes.
    expect(readFileSync(path, 'utf8')).toBe(line(3))
    expect(readFileSync(`${path}.1`, 'utf8')).toBe(line(2))
    expect(readFileSync(`${path}.2`, 'utf8')).toBe(line(1))
  })

  test('keeps at most maxFiles rotated files, pruning the oldest', () => {
    const sink = new RotatingFileSink({ path, maxBytes: 15, maxFiles: 2 })
    // 10-byte lines with a 15-byte cap → every write after the first rotates.
    for (let i = 1; i <= 5; i++)
      sink.write(line(i))
    sink.close()

    expect(existsSync(`${path}.1`)).toBe(true)
    expect(existsSync(`${path}.2`)).toBe(true)
    expect(existsSync(`${path}.3`)).toBe(false)
    // Active holds the newest line; .1 the one before it; .2 before that.
    expect(readFileSync(path, 'utf8')).toBe(line(5))
    expect(readFileSync(`${path}.1`, 'utf8')).toBe(line(4))
    expect(readFileSync(`${path}.2`, 'utf8')).toBe(line(3))
  })

  test('with maxFiles 0 it truncates instead of keeping history', () => {
    const sink = new RotatingFileSink({ path, maxBytes: 10, maxFiles: 0 })
    sink.write(line(1))
    sink.write(line(2))
    sink.close()

    expect(existsSync(`${path}.1`)).toBe(false)
    expect(readFileSync(path, 'utf8')).toBe(line(2))
  })

  test('resumes byte accounting from an existing file on construction', () => {
    new RotatingFileSink({ path, maxBytes: 1000, maxFiles: 2 }).write(line(1))
    // A fresh sink over the same path should append, not rotate immediately.
    const resumed = new RotatingFileSink({ path, maxBytes: 1000, maxFiles: 2 })
    resumed.write(line(2))
    resumed.close()

    expect(readFileSync(path, 'utf8')).toBe(line(1) + line(2))
  })
})
