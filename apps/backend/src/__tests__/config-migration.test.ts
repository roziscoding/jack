import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'bun:test'
import { jsonc } from 'jsonc'
import { getAppConfig, MIGRATIONS } from '../lib/config'

const paths: string[] = []
afterEach(async () => {
  for (const p of paths.splice(0)) {
    await rm(p, { force: true })
    await rm(`${p}.bak`, { force: true })
    await rm(`${p}.tmp`, { force: true })
  }
})

function tempPath() {
  const p = join(tmpdir(), `jack-cfg-${Math.random().toString(36).slice(2)}.jsonc`)
  paths.push(p)
  return p
}

describe('Config migration write-back', () => {
  test('migrates a v0 file, backs it up, and persists', async () => {
    const path = tempPath()
    const original = jsonc.stringify({ version: 0, jack: { baseUrl: 'http://jack:5225' }, peers: [], servers: [] }, { space: 2 })
    await Bun.write(path, original)

    const { appConfig } = await getAppConfig({ APP_CONFIG_PATH: path })
    expect(appConfig.version).toBe(MIGRATIONS.length)

    expect(await Bun.file(`${path}.bak`).text()).toBe(original)
    const reread = jsonc.parse(await Bun.file(path).text()) as { version: number }
    expect(reread.version).toBe(MIGRATIONS.length)
  })

  test('leaves an up-to-date file untouched (no .bak)', async () => {
    const path = tempPath()
    const current = jsonc.stringify({ version: MIGRATIONS.length, jack: { baseUrl: 'http://jack:5225' }, peers: [], servers: [] }, { space: 2 })
    await Bun.write(path, current)

    await getAppConfig({ APP_CONFIG_PATH: path })

    expect(await Bun.file(`${path}.bak`).exists()).toBe(false)
    expect(await Bun.file(path).text()).toBe(current)
  })
})
