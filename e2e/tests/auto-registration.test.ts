import type { TestEnv } from '../helpers'
import { beforeAll, describe, expect, test } from 'bun:test'
import { fetchJson, getTestEnv, retry } from '../helpers'

let env: TestEnv

beforeAll(async () => {
  env = await getTestEnv()
})

describe('Auto-registration (e2e)', () => {
  test('Jack Alpha does NOT register as indexer (source-only: no destination servers)', async () => {
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

  test('Jack Beta registered as qBittorrent download client in Radarr', async () => {
    const jackClient = await retry(async () => {
      const clients = await fetchJson<Array<{ name: string, implementation: string, fields: Array<{ name: string, value: unknown }> }>>(
        `${env.radarrUrl}/api/v3/downloadclient`,
        { headers: { 'X-Api-Key': env.radarrApiKey } },
      )

      const registered = clients.find(client =>
        client.name === 'Jack' && client.implementation === 'QBittorrent',
      )
      if (!registered)
        throw new Error('Jack Beta download client is not registered yet')

      return registered
    }, { retries: 30, delay: 1_000 })

    expect(jackClient.name).toBe('Jack')
    expect(jackClient.implementation).toBe('QBittorrent')
    // Points at jack-beta's own /api/v2 (host from jack.baseUrl http://jack-beta:3000).
    const host = jackClient.fields?.find(f => f.name === 'host')?.value
    const port = jackClient.fields?.find(f => f.name === 'port')?.value
    expect(host).toBe('jack-beta')
    expect(port).toBe(3000)
  })

  test('Jack indexer is BOUND to the Jack qBittorrent download client', async () => {
    const headers = { 'X-Api-Key': env.radarrApiKey }

    // The Jack qBittorrent client's id.
    const clients = await retry(async () => {
      const list = await fetchJson<Array<{ id: number, name: string, implementation: string }>>(
        `${env.radarrUrl}/api/v3/downloadclient`,
        { headers },
      )
      const jack = list.find(c => c.name === 'Jack' && c.implementation === 'QBittorrent')
      if (!jack)
        throw new Error('Jack qBittorrent client not registered yet')
      return jack
    }, { retries: 30, delay: 1_000 })

    // The Jack indexer must point its Download Client at exactly that client
    // (downloadClientId), not 0/"Any" — otherwise *arr may route a Jack grab to
    // an unrelated client. This is the regression guard for the binding bug.
    const indexer = await retry(async () => {
      const list = await fetchJson<Array<{ name: string, downloadClientId: number, fields: Array<{ name: string, value: unknown }> }>>(
        `${env.radarrUrl}/api/v3/indexer`,
        { headers },
      )
      const jack = list.find(idx =>
        idx.fields?.some(f => f.name === 'baseUrl' && String(f.value).includes('jack-beta')),
      )
      if (!jack)
        throw new Error('Jack indexer not registered yet')
      return jack
    }, { retries: 30, delay: 1_000 })

    expect(indexer.downloadClientId).toBe(clients.id)
  })
})
