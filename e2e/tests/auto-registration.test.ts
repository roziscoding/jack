import type { TestEnv } from '../helpers'
import { beforeAll, describe, expect, test } from 'bun:test'
import { fetchJson, getTestEnv, retry } from '../helpers'

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
    const jackIndexer = await retry(async () => {
      const indexers = await fetchJson<Array<{ name: string, fields: Array<{ name: string, value: unknown }> }>>(
        `${env.radarrUrl}/api/v3/indexer`,
        { headers: { 'X-Api-Key': env.radarrApiKey } },
      )

      const registered = indexers.find(idx =>
        idx.fields?.some(f => f.name === 'baseUrl' && String(f.value).includes('jack-beta')),
      )
      if (!registered)
        throw new Error('Jack Beta indexer is not registered yet')

      return registered
    }, { retries: 30, delay: 1_000 })

    expect(jackIndexer.name).toBe('Jack')
  })

  test('Jack Beta registered as Torrent Blackhole download client in Radarr', async () => {
    const jackClient = await retry(async () => {
      const clients = await fetchJson<Array<{ name: string, implementation: string, fields: Array<{ name: string, value: unknown }> }>>(
        `${env.radarrUrl}/api/v3/downloadclient`,
        { headers: { 'X-Api-Key': env.radarrApiKey } },
      )

      const registered = clients.find(client =>
        client.fields?.some(f => f.name === 'torrentFolder' && f.value === '/downloads/watch'),
      )
      if (!registered)
        throw new Error('Jack Beta download client is not registered yet')

      return registered
    }, { retries: 30, delay: 1_000 })

    expect(jackClient.name).toBe('Jack')
    expect(jackClient.implementation).toBe('TorrentBlackhole')
  })
})
