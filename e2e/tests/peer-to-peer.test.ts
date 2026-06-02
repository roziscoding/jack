import type { TestEnv } from '../helpers'
import { beforeAll, describe, expect, test } from 'bun:test'
import { getTestEnv } from '../helpers'

let env: TestEnv

interface PeerRelease {
  id: string
  title: string
  filename: string
  category: number
}

beforeAll(async () => {
  env = await getTestEnv()
})

describe('Peer-to-Peer API (e2e)', () => {
  test('GET /peer/search returns releases from the local Radarr', async () => {
    const res = await fetch(`${env.jackAlphaUrl}/peer/search?q=Big+Buck&apikey=${env.jackAlphaApiKey}`)
    expect(res.status).toBe(200)
    const body = await res.json() as { items: PeerRelease[] }
    expect(body.items).toBeArray()
    expect(body.items.length).toBeGreaterThan(0)
    expect(body.items.some(i => i.title.includes('Big Buck Bunny'))).toBe(true)
  })

  test('GET /peer/search rejects wrong API key', async () => {
    const res = await fetch(`${env.jackAlphaUrl}/peer/search?q=test&apikey=wrong-key`)
    expect(res.status).toBe(401)
  })

  test('GET /peer/items/:id returns the release', async () => {
    const searchRes = await fetch(`${env.jackAlphaUrl}/peer/search?q=Big+Buck&apikey=${env.jackAlphaApiKey}`)
    const searchBody = await searchRes.json() as { items: PeerRelease[] }
    const releaseId = searchBody.items[0]!.id

    const res = await fetch(`${env.jackAlphaUrl}/peer/items/${encodeURIComponent(releaseId)}?apikey=${env.jackAlphaApiKey}`)
    expect(res.status).toBe(200)
    const body = await res.json() as PeerRelease
    expect(body.id).toBe(releaseId)
  })

  test('GET /peer/items/:id/file streams the media file', async () => {
    const searchRes = await fetch(`${env.jackAlphaUrl}/peer/search?q=Big+Buck&apikey=${env.jackAlphaApiKey}`)
    const searchBody = await searchRes.json() as { items: PeerRelease[] }
    const releaseId = searchBody.items[0]!.id

    const res = await fetch(`${env.jackAlphaUrl}/peer/items/${encodeURIComponent(releaseId)}/file?apikey=${env.jackAlphaApiKey}`)
    expect(res.status).toBe(200)
    const data = await res.arrayBuffer()
    expect(data.byteLength).toBeGreaterThan(0)
  })
})
