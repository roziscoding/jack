import type { TestEnv } from '../helpers'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { beforeAll, describe, expect, test } from 'bun:test'
import { fetchJson, getTestEnv, retry } from '../helpers'

let env: TestEnv

const BLACKHOLE_COMPLETED = join(import.meta.dir, '..', 'volumes', 'blackhole-completed')

// jack-beta's destination *arr connector name (see e2e/setup.ts → betaConfig).
const DEST_CONNECTOR_NAME = 'Test Radarr'
// The docker-internal URL jack-beta uses for that *arr; the category is derived
// from it the same way jack does (sha256(url).slice(0, 8)).
const DEST_INTERNAL_URL = 'http://radarr:7878'

// Mirror ServerConnector's id derivation (lib/servers/base.ts).
function serverId(url: string): string {
  return new Bun.CryptoHasher('sha256').update(url).digest('hex').slice(0, 8)
}

function qbCategory(url: string): string {
  return `jack-${serverId(url)}`
}

beforeAll(async () => {
  env = await getTestEnv()
})

describe('qBittorrent flow (e2e)', () => {
  test('qB path: login → add → progress → import, and *arr lists the qB client', async () => {
    const jack = env.jackBetaUrl
    const category = qbCategory(DEST_INTERNAL_URL)

    // 1. Log in to jack's qBittorrent API as the destination connector.
    //    username = connector name, password = jack-beta's apiKey.
    const loginRes = await fetch(`${jack}/api/v2/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ username: DEST_CONNECTOR_NAME, password: env.jackBetaApiKey }),
    })
    expect(loginRes.status).toBe(200)
    expect(await loginRes.text()).toBe('Ok.')
    const cookie = (loginRes.headers.get('set-cookie') ?? '').split(';')[0] ?? ''
    expect(cookie).toContain('SID=')

    // 2. Discover a Jack release URL via the Torznab search jack-beta exposes.
    const searchRes = await fetch(`${jack}/torznab/api?t=search&apikey=${env.jackBetaApiKey}`)
    expect(searchRes.status).toBe(200)
    const xml = await searchRes.text()
    const enclosureMatch = xml.match(/url="([^"]*\.torrent[^"]*)"/)
    expect(enclosureMatch).not.toBeNull()
    const downloadUrl = enclosureMatch![1]!
      .replace('http://jack-beta:3000', jack)
      .replace(/&amp;/g, '&')

    // 3. Add it through the qB API (multipart: urls = jack's own stub URL).
    const addForm = new FormData()
    addForm.append('urls', downloadUrl)
    addForm.append('category', category)
    const addRes = await fetch(`${jack}/api/v2/torrents/add`, {
      method: 'POST',
      headers: { cookie },
      body: addForm,
    })
    expect(addRes.status).toBe(200)
    expect(await addRes.text()).toBe('Ok.')

    // 4. Poll torrents/info until the torrent finishes (state pausedUP, progress 1).
    const finished = await retry(async () => {
      const infoRes = await fetch(`${jack}/api/v2/torrents/info?category=${encodeURIComponent(category)}`, {
        headers: { cookie },
      })
      if (infoRes.status !== 200)
        throw new Error(`torrents/info ${infoRes.status}`)
      const torrents = await infoRes.json() as Array<{ name: string, state: string, progress: number }>
      const done = torrents.find(t => t.state === 'pausedUP' && t.progress === 1)
      if (!done)
        throw new Error(`no completed torrent yet (have ${JSON.stringify(torrents.map(t => ({ s: t.state, p: t.progress })))})`)
      return done
    }, { retries: 30, delay: 2_000 })

    expect(finished.state).toBe('pausedUP')
    expect(finished.progress).toBe(1)

    // 5. The completed media file exists in jack's completedPath.
    const completedFiles = (await readdir(BLACKHOLE_COMPLETED)).filter(f => !f.endsWith('.torrent'))
    expect(completedFiles.length).toBeGreaterThan(0)

    // 6. The destination *arr lists a QBittorrent download client.
    const clients = await fetchJson<Array<{ implementation: string }>>(
      `${env.radarrUrl}/api/v3/downloadclient`,
      { headers: { 'X-Api-Key': env.radarrApiKey } },
    )
    expect(clients.some(client => client.implementation === 'QBittorrent')).toBe(true)
  }, 120_000)
})
