import type { TestEnv } from '../helpers'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { beforeAll, describe, expect, test } from 'bun:test'
import { getTestEnv, retry } from '../helpers'

let env: TestEnv

const BLACKHOLE_WATCH = join(import.meta.dir, '..', 'volumes', 'blackhole-watch')
const BLACKHOLE_COMPLETED = join(import.meta.dir, '..', 'volumes', 'blackhole-completed')

beforeAll(async () => {
  env = await getTestEnv()
})

describe('Download flow (e2e)', () => {
  test('Full blackhole download: search → torrent → download → import', async () => {
    // 1. Search via jack-beta's Torznab API
    const searchRes = await fetch(`${env.jackBetaUrl}/torznab/api?t=search&apikey=${env.jackBetaApiKey}`)
    expect(searchRes.status).toBe(200)
    const xml = await searchRes.text()

    // 2. Extract the download URL from the RSS XML
    const enclosureMatch = xml.match(/url="([^"]*\.torrent[^"]*)"/)
    expect(enclosureMatch).not.toBeNull()

    // The URL in the XML will have the docker-internal host, replace with localhost
    let downloadUrl = enclosureMatch![1]!
      .replace('http://jack-beta:3000', env.jackBetaUrl)
      .replace(/&amp;/g, '&')

    // Ensure apikey is in the URL
    if (!downloadUrl.includes('apikey=')) {
      downloadUrl += `${downloadUrl.includes('?') ? '&' : '?'}apikey=${env.jackBetaApiKey}`
    }

    // 3. Download the .torrent stub
    const torrentRes = await fetch(downloadUrl)
    expect(torrentRes.status).toBe(200)
    expect(torrentRes.headers.get('Content-Type')).toBe('application/x-bittorrent')
    const torrentData = await torrentRes.arrayBuffer()
    expect(torrentData.byteLength).toBeGreaterThan(0)

    // 4. Write the .torrent to the blackhole watch directory
    const torrentPath = join(BLACKHOLE_WATCH, 'test-download.torrent')
    await Bun.write(torrentPath, torrentData)

    // 5. Wait for jack-beta's BlackholeWatcher to process it
    const completedFiles = await retry(async () => {
      const files = await readdir(BLACKHOLE_COMPLETED)
      const mediaFiles = files.filter(f => !f.endsWith('.torrent'))
      if (mediaFiles.length === 0)
        throw new Error('No completed files yet')
      return mediaFiles
    }, { retries: 30, delay: 2_000 })

    // 6. Verify a file was downloaded to completed
    expect(completedFiles.length).toBeGreaterThan(0)

    // 7. Verify the .torrent was cleaned up from watch dir
    const watchFiles = await readdir(BLACKHOLE_WATCH)
    const remainingTorrents = watchFiles.filter(f => f === 'test-download.torrent')
    expect(remainingTorrents.length).toBe(0)
  }, 120_000) // 2 minute timeout for the full flow
})
