import { describe, test, expect, beforeAll } from 'bun:test'
import { getTestEnv, type TestEnv } from '../helpers'

let env: TestEnv

beforeAll(async () => {
  env = await getTestEnv()
})

describe('Peer-to-Peer API (e2e)', () => {
  test('GET /peer/search returns items from Jellyfin', async () => {
    const res = await fetch(`${env.jackAlphaUrl}/peer/search?q=Big+Buck&apikey=${env.jackAlphaApiKey}`)
    expect(res.status).toBe(200)
    const body = await res.json() as { items: Array<{ Name: string }> }
    expect(body.items).toBeArray()
    expect(body.items.length).toBeGreaterThan(0)
    expect(body.items.some(i => i.Name.includes('Big Buck Bunny'))).toBe(true)
  })

  test('GET /peer/search rejects wrong API key', async () => {
    const res = await fetch(`${env.jackAlphaUrl}/peer/search?q=test&apikey=wrong-key`)
    expect(res.status).toBe(401)
  })

  test('GET /peer/items/:id returns item metadata', async () => {
    // First find an item ID
    const searchRes = await fetch(`${env.jackAlphaUrl}/peer/search?q=Big+Buck&apikey=${env.jackAlphaApiKey}`)
    const searchBody = await searchRes.json() as { items: Array<{ Id: string, Name: string }> }
    const itemId = searchBody.items[0].Id

    const res = await fetch(`${env.jackAlphaUrl}/peer/items/${itemId}?apikey=${env.jackAlphaApiKey}`)
    expect(res.status).toBe(200)
    const body = await res.json() as { Name: string, Id: string }
    expect(body.Id).toBe(itemId)
  })

  test('GET /peer/items/:id/file streams the media file', async () => {
    const searchRes = await fetch(`${env.jackAlphaUrl}/peer/search?q=Big+Buck&apikey=${env.jackAlphaApiKey}`)
    const searchBody = await searchRes.json() as { items: Array<{ Id: string }> }
    const itemId = searchBody.items[0].Id

    const res = await fetch(`${env.jackAlphaUrl}/peer/items/${itemId}/file?apikey=${env.jackAlphaApiKey}`)
    expect(res.status).toBe(200)
    const data = await res.arrayBuffer()
    expect(data.byteLength).toBeGreaterThan(0)
  })
})
