import type { TestEnv } from '../helpers'
import { beforeAll, describe, expect, test } from 'bun:test'
import { getTestEnv } from '../helpers'

let env: TestEnv

beforeAll(async () => {
  env = await getTestEnv()
})

describe('Torznab Search (e2e)', () => {
  test('GET /torznab/api?t=caps returns XML capabilities', async () => {
    const res = await fetch(`${env.jackBetaUrl}/torznab/api?t=caps&apikey=${env.jackBetaApiKey}`)
    expect(res.status).toBe(200)
    const xml = await res.text()
    expect(xml).toContain('<caps>')
    expect(xml).toContain('category id="2000"')
    expect(xml).toContain('category id="5000"')
  })

  test('GET /torznab/api?t=search finds items via peer', async () => {
    const res = await fetch(`${env.jackBetaUrl}/torznab/api?t=search&apikey=${env.jackBetaApiKey}`)
    expect(res.status).toBe(200)
    const xml = await res.text()
    expect(xml).toContain('<rss version="2.0"')
    expect(xml).toContain('Big Buck Bunny')
    expect(xml).toContain('application/x-bittorrent')
  })

  test('GET /torznab/api?t=movie searches by IMDB ID', async () => {
    const res = await fetch(`${env.jackBetaUrl}/torznab/api?t=movie&imdbid=tt1254207&apikey=${env.jackBetaApiKey}`)
    expect(res.status).toBe(200)
    const xml = await res.text()
    expect(xml).toContain('Big Buck Bunny')
  })

  test('Torznab rejects wrong API key', async () => {
    const res = await fetch(`${env.jackBetaUrl}/torznab/api?t=caps&apikey=wrong-key`)
    expect(res.status).toBe(403)
    const xml = await res.text()
    expect(xml).toContain('Incorrect API Key')
  })

  test('Torznab rejects unknown function', async () => {
    const res = await fetch(`${env.jackBetaUrl}/torznab/api?t=unknown&apikey=${env.jackBetaApiKey}`)
    expect(res.status).toBe(400)
    const xml = await res.text()
    expect(xml).toContain('Unknown function')
  })
})
