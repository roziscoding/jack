import type { Envs } from '../lib/envs'
import type { Release } from '../lib/release'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { getApp } from '../app'
import { openDatabase } from '../database/connection'
import { AppConfig } from '../lib/config'
import { DownloadsRepository } from '../modules/downloads/downloads.repository'

const envs: Envs = {
  APP_CONFIG_PATH: '/config/config.jsonc',
  ENABLE_LOGS: false,
  ENVIRONMENT: 'test' as any,
  HTTP_TIMEOUT_MS: 3000,
  LOG_LEVEL: 'fatal',
  OTEL_SERVICE_NAME: 'jack-server',
  PORT: 3000,
  NODE_ENV: 'test',
}

const config = AppConfig.parse({
  jack: { baseUrl: 'http://localhost:3000', apiKey: 'test-api-key' },
  downloads: { completedPath: '/tmp/completed' },
  servers: [],
  peers: [],
})

const release: Release = {
  id: 'remote:movie:1',
  title: 'Movie.2024.1080p',
  filename: 'Movie.2024.1080p.mkv',
  category: 2000,
  size: 100,
}

let tempDir: string

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'jack-downloads-api-'))
})

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true })
})

function seed(repository: DownloadsRepository) {
  return repository.create({
    torrentFilename: 'movie.torrent',
    peerId: 'peer-1',
    peerName: 'Friend Jack',
    itemId: 'movie:1',
    filename: release.filename,
    destPath: join(tempDir, release.filename),
    partPath: join(tempDir, `${release.filename}.part`),
    releaseSize: release.size,
    release,
  })
}

describe('downloads API', () => {
  test('GET /downloads lists persisted downloads', async () => {
    const handle = await openDatabase({ appConfigPath: join(tempDir, 'config.jsonc') })
    const repository = new DownloadsRepository(handle.db)
    const created = seed(repository)

    const app = getApp(envs, config, { servers: [], peers: [] }, { downloadsRepository: repository })
    const response = await app.request('/downloads', { headers: { 'X-Api-Key': 'test-api-key' } })
    const body = await response.json() as { downloads: Array<{ id: number, torrentFilename: string }> }

    expect(response.status).toBe(200)
    expect(body.downloads).toHaveLength(1)
    expect(body.downloads[0]?.id).toBe(created.id)
    expect(body.downloads[0]?.torrentFilename).toBe('movie.torrent')
    handle.close()
  })

  test('GET /downloads/:id returns one download or 404', async () => {
    const handle = await openDatabase({ appConfigPath: join(tempDir, 'config.jsonc') })
    const repository = new DownloadsRepository(handle.db)
    const created = seed(repository)

    const app = getApp(envs, config, { servers: [], peers: [] }, { downloadsRepository: repository })
    const found = await app.request(`/downloads/${created.id}`, { headers: { 'X-Api-Key': 'test-api-key' } })
    const missing = await app.request('/downloads/999999', { headers: { 'X-Api-Key': 'test-api-key' } })

    expect(found.status).toBe(200)
    expect((await found.json() as { id: number }).id).toBe(created.id)
    expect(missing.status).toBe(404)
    handle.close()
  })
})
