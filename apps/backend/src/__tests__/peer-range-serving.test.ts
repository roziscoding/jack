import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { parseRangeHeader, PeerController } from '../modules/peer/peer.controller'
import { getPeerRouter } from '../modules/peer/peer.router'

describe('parseRangeHeader', () => {
  test('returns null for absent or malformed headers', () => {
    expect(parseRangeHeader(undefined)).toBeNull()
    expect(parseRangeHeader('')).toBeNull()
    expect(parseRangeHeader('bytes=abc')).toBeNull()
    expect(parseRangeHeader('bytes=-')).toBeNull()
    expect(parseRangeHeader('items=0-1')).toBeNull()
  })

  test('parses normal, open-ended, and suffix ranges', () => {
    expect(parseRangeHeader('bytes=2-4')).toEqual({ start: 2, end: 4 })
    expect(parseRangeHeader('bytes=5-')).toEqual({ start: 5, end: undefined })
    expect(parseRangeHeader('bytes=-3')).toEqual({ start: undefined, end: 3 })
  })
})

let tempDir: string
let filePath: string

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'jack-range-'))
  filePath = join(tempDir, 'Movie.mkv')
  await writeFile(filePath, new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]))
})

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true })
})

function controllerForFile() {
  const source = {
    id: 'remote1',
    name: 'My Radarr',
    type: 'radarr',
    canSource: true,
    getFilePath: async () => filePath,
  }
  return new PeerController([source as any])
}

async function streamBytes(stream: ReadableStream): Promise<number[]> {
  const reader = stream.getReader()
  const chunks: number[] = []
  while (true) {
    const { done, value } = await reader.read()
    if (done)
      break
    if (value)
      chunks.push(...value)
  }
  return chunks
}

describe('PeerController.streamFile range handling', () => {
  test('returns a partial slice for a normal range', async () => {
    const result = await controllerForFile().streamFile('remote1:movie:1', 'bytes=2-4')
    expect(result?.type).toBe('partial')
    if (result?.type !== 'partial')
      throw new Error('expected partial')
    expect({ start: result.start, end: result.end, size: result.size, totalSize: result.totalSize }).toEqual({ start: 2, end: 4, size: 3, totalSize: 10 })
    expect(await streamBytes(result.stream)).toEqual([2, 3, 4])
  })

  test('returns the last N bytes for a suffix range', async () => {
    const result = await controllerForFile().streamFile('remote1:movie:1', 'bytes=-3')
    if (result?.type !== 'partial')
      throw new Error('expected partial')
    expect(await streamBytes(result.stream)).toEqual([7, 8, 9])
  })

  test('clamps an open-ended range to the file end', async () => {
    const result = await controllerForFile().streamFile('remote1:movie:1', 'bytes=8-')
    if (result?.type !== 'partial')
      throw new Error('expected partial')
    expect(result.end).toBe(9)
    expect(await streamBytes(result.stream)).toEqual([8, 9])
  })

  test('reports unsatisfiable when start is beyond the file', async () => {
    const result = await controllerForFile().streamFile('remote1:movie:1', 'bytes=20-30')
    expect(result).toEqual({ type: 'unsatisfiable', totalSize: 10 })
  })

  test('serves the full file when there is no range', async () => {
    const result = await controllerForFile().streamFile('remote1:movie:1')
    if (result?.type !== 'full')
      throw new Error('expected full')
    expect(result.size).toBe(10)
    expect(await streamBytes(result.stream)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
  })

  test('returns null when the source is unknown', async () => {
    const result = await controllerForFile().streamFile('unknown:movie:1', 'bytes=0-1')
    expect(result).toBeNull()
  })
})

describe('GET /peer/items/:id/file range responses', () => {
  function appForFile() {
    const app = new Hono()
    app.route('/peer', getPeerRouter(controllerForFile()))
    return app
  }

  test('serves 200 + Accept-Ranges for a full request', async () => {
    const res = await appForFile().request('/peer/items/remote1:movie:1/file')
    expect(res.status).toBe(200)
    expect(res.headers.get('Accept-Ranges')).toBe('bytes')
    expect(res.headers.get('Content-Length')).toBe('10')
  })

  test('serves 206 + Content-Range for a valid range', async () => {
    const res = await appForFile().request('/peer/items/remote1:movie:1/file', { headers: { Range: 'bytes=2-4' } })
    expect(res.status).toBe(206)
    expect(res.headers.get('Content-Range')).toBe('bytes 2-4/10')
    expect(res.headers.get('Content-Length')).toBe('3')
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([2, 3, 4]))
  })

  test('serves 416 for an unsatisfiable range', async () => {
    const res = await appForFile().request('/peer/items/remote1:movie:1/file', { headers: { Range: 'bytes=50-60' } })
    expect(res.status).toBe(416)
    expect(res.headers.get('Content-Range')).toBe('bytes */10')
  })

  test('returns 404 for an unknown item', async () => {
    const res = await appForFile().request('/peer/items/unknown:movie:1/file', { headers: { Range: 'bytes=0-1' } })
    expect(res.status).toBe(404)
  })
})
