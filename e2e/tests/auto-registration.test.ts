import { describe, test, expect, beforeAll } from 'bun:test'
import { getTestEnv, fetchJson, type TestEnv } from '../helpers'

let env: TestEnv

beforeAll(async () => {
  env = await getTestEnv()
})

describe('Auto-registration (e2e)', () => {
  test('Jack Alpha does NOT register as indexer (no peers = no Torznab)', async () => {
    const indexers = await fetchJson<Array<{ name: string, fields: Array<{ name: string, value: unknown }> }>>(
      `${env.radarrUrl}/api/v3/indexer`,
      { headers: { 'X-Api-Key': env.radarrApiKey } },
    )

    const alphaIndexer = indexers.find(idx =>
      idx.fields?.some(f => f.name === 'baseUrl' && String(f.value).includes('jack-alpha')),
    )
    expect(alphaIndexer).toBeUndefined()
  })

  test('Jack Beta registered as indexer in Radarr', async () => {
    const indexers = await fetchJson<Array<{ name: string, fields: Array<{ name: string, value: unknown }> }>>(
      `${env.radarrUrl}/api/v3/indexer`,
      { headers: { 'X-Api-Key': env.radarrApiKey } },
    )

    const jackIndexer = indexers.find(idx =>
      idx.fields?.some(f => f.name === 'baseUrl' && String(f.value).includes('jack-beta')),
    )
    expect(jackIndexer).toBeDefined()
    expect(jackIndexer!.name).toBe('Jack')
  })
})
