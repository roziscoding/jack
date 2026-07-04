import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { LogHub } from './log-hub'

let dir: string
let path: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'jack-loghub-'))
  path = join(dir, 'jack.ndjson')
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

function ndjson(records: object[]): string {
  return `${records.map(r => JSON.stringify(r)).join('\n')}\n`
}

describe('LogHub live fan-out', () => {
  test('delivers parsed records to subscribers', () => {
    const hub = new LogHub(path)
    const seen: unknown[] = []
    hub.subscribe(r => seen.push(r))

    hub.write(`${JSON.stringify({ level: 30, message: 'hi' })}\n`)

    expect(seen).toEqual([{ level: 30, message: 'hi' }])
  })

  test('is a no-op with no subscribers and ignores malformed lines', () => {
    const hub = new LogHub(path)
    const seen: unknown[] = []
    hub.write('not json') // no subscribers → nothing happens, no throw
    const unsub = hub.subscribe(r => seen.push(r))
    hub.write('still not json\n')

    expect(seen).toEqual([])
    unsub()
    expect(hub.subscriberCount).toBe(0)
  })

  test('unsubscribe stops delivery', () => {
    const hub = new LogHub(path)
    const seen: unknown[] = []
    const unsub = hub.subscribe(r => seen.push(r))
    hub.write(`${JSON.stringify({ level: 30, message: 'a' })}\n`)
    unsub()
    hub.write(`${JSON.stringify({ level: 30, message: 'b' })}\n`)

    expect(seen).toHaveLength(1)
  })

  test('a throwing subscriber does not break the others', () => {
    const hub = new LogHub(path)
    const seen: unknown[] = []
    hub.subscribe(() => {
      throw new Error('boom')
    })
    hub.subscribe(r => seen.push(r))

    hub.write(`${JSON.stringify({ level: 40, message: 'x' })}\n`)

    expect(seen).toHaveLength(1)
  })
})

describe('LogHub backfill', () => {
  test('returns the last N records oldest→newest', async () => {
    await writeFile(path, ndjson([
      { level: 30, message: 'a' },
      { level: 30, message: 'b' },
      { level: 30, message: 'c' },
    ]))
    const hub = new LogHub(path)

    const out = await hub.backfill({ lines: 2 })

    expect(out.map(r => r.message)).toEqual(['b', 'c'])
  })

  test('filters below the minimum level', async () => {
    await writeFile(path, ndjson([
      { level: 30, message: 'info' },
      { level: 40, message: 'warn' },
      { level: 50, message: 'error' },
    ]))
    const hub = new LogHub(path)

    const out = await hub.backfill({ lines: 10, minLevel: 40 })

    expect(out.map(r => r.message)).toEqual(['warn', 'error'])
  })

  test('reads across rotated files to fulfill the requested line count', async () => {
    // Older history lives in .1; the active file holds the newest lines.
    await writeFile(`${path}.1`, ndjson([
      { level: 30, message: 'a' },
      { level: 30, message: 'b' },
    ]))
    await writeFile(path, ndjson([
      { level: 30, message: 'c' },
      { level: 30, message: 'd' },
    ]))
    const hub = new LogHub(path)

    const out = await hub.backfill({ lines: 3 })

    expect(out.map(r => r.message)).toEqual(['b', 'c', 'd'])
  })

  test('does not read older files once enough recent lines are collected', async () => {
    await writeFile(`${path}.1`, ndjson([{ level: 30, message: 'old' }]))
    await writeFile(path, ndjson([
      { level: 30, message: 'x' },
      { level: 30, message: 'y' },
    ]))
    const hub = new LogHub(path)

    const out = await hub.backfill({ lines: 2 })

    expect(out.map(r => r.message)).toEqual(['x', 'y'])
  })

  test('fails closed: a record without a numeric level is excluded under a level floor', async () => {
    await writeFile(path, `${[
      { level: 30, message: 'info' },
      { message: 'no-level' },
      { level: 50, message: 'error' },
    ].map(r => JSON.stringify(r)).join('\n')}\n`)
    const hub = new LogHub(path)

    const out = await hub.backfill({ lines: 10, minLevel: 40 })

    expect(out.map(r => r.message)).toEqual(['error'])
  })

  test('returns empty when the file does not exist', async () => {
    const hub = new LogHub(join(dir, 'missing.ndjson'))
    expect(await hub.backfill({ lines: 10 })).toEqual([])
  })

  test('skips malformed lines', async () => {
    await writeFile(path, `${JSON.stringify({ level: 30, message: 'ok' })}\nGARBAGE\n`)
    const hub = new LogHub(path)

    const out = await hub.backfill({ lines: 10 })

    expect(out.map(r => r.message)).toEqual(['ok'])
  })
})
