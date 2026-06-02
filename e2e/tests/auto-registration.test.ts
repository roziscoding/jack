import type { TestEnv } from '../helpers'
import { beforeAll, describe, expect, test } from 'bun:test'
import { fetchJson, getTestEnv } from '../helpers'

let env: TestEnv

beforeAll(async () => {
  env = await getTestEnv()
})

describe('Auto-registration (e2e)', () => {
  test('Jack Alpha does NOT register as indexer (no peers = nothing to search)', async () => {
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

  test('Jack Beta registered as Torrent Blackhole download client in Radarr', async () => {
    const clients = await fetchJson<Array<{ name: string, implementation: string, fields: Array<{ name: string, value: unknown }> }>>(
      `${env.radarrUrl}/api/v3/downloadclient`,
      { headers: { 'X-Api-Key': env.radarrApiKey } },
    )

    const jackClient = clients.find(client =>
      client.fields?.some(f => f.name === 'torrentFolder' && f.value === '/downloads/watch'),
    )
    expect(jackClient).toBeDefined()
    expect(jackClient!.name).toBe('Jack')
    expect(jackClient!.implementation).toBe('TorrentBlackhole')
  })
})
