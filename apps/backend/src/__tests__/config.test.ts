import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import z from 'zod'
import { AppConfig, ConfigSecret, JackConfig, PeerConfig, ServerConfig } from '../lib/config'

const HEX_KEY = '0123456789abcdef0123456789abcdef'

describe('configSecret', () => {
  const savedEnv = { ...process.env }
  let emptyFile: string
  let hexFile: string
  let secretFile: string
  let tempDir: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'jack-config-secret-'))
    emptyFile = join(tempDir, 'empty')
    hexFile = join(tempDir, 'hex')
    secretFile = join(tempDir, 'secret')

    writeFileSync(emptyFile, '\n')
    writeFileSync(hexFile, `${HEX_KEY}\n`)
    writeFileSync(secretFile, 'file-secret\n')

    process.env.MY_SECRET = 'super-secret'
    process.env.MY_HEX = HEX_KEY
    delete process.env.UNSET_SECRET
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
    process.env = { ...savedEnv }
  })

  test('passes a plain string through unchanged', () => {
    expect(ConfigSecret().parse('plain-value')).toBe('plain-value')
  })

  test('resolves an { env } reference from the environment', () => {
    expect(ConfigSecret().parse({ env: 'MY_SECRET' })).toBe('super-secret')
  })

  test('resolves a { file } reference from an absolute path', () => {
    expect(ConfigSecret().parse({ file: secretFile })).toBe('file-secret')
  })

  test('fails with a clear message when the referenced env var is not set', () => {
    const result = ConfigSecret().safeParse({ env: 'UNSET_SECRET' })
    expect(result.success).toBe(false)
    expect(result.error?.issues[0]?.message).toContain('UNSET_SECRET')
  })

  test('fails when the referenced env var is empty', () => {
    process.env.EMPTY_SECRET = ''
    expect(ConfigSecret().safeParse({ env: 'EMPTY_SECRET' }).success).toBe(false)
  })

  test('fails when the referenced file path is not absolute', () => {
    const result = ConfigSecret().safeParse({ file: 'secret-file' })
    expect(result.success).toBe(false)
    expect(result.error?.issues[0]?.message).toContain('must be absolute')
  })

  test('fails with a clear message when the referenced file cannot be read', () => {
    const missingFile = join(tempDir, 'missing')
    const result = ConfigSecret().safeParse({ file: missingFile })
    expect(result.success).toBe(false)
    expect(result.error?.issues[0]?.message).toContain(missingFile)
  })

  test('rejects an empty plain string by default', () => {
    expect(ConfigSecret().safeParse('').success).toBe(false)
  })

  test('rejects an empty file-resolved string by default', () => {
    expect(ConfigSecret().safeParse({ file: emptyFile }).success).toBe(false)
  })

  test('applies the inner schema to plain strings', () => {
    const secret = ConfigSecret(z.hex().min(32).max(32))
    expect(secret.parse(HEX_KEY)).toBe(HEX_KEY)
    expect(secret.safeParse('not-hex').success).toBe(false)
  })

  test('applies the inner schema to env-resolved values', () => {
    const secret = ConfigSecret(z.hex().min(32).max(32))
    expect(secret.parse({ env: 'MY_HEX' })).toBe(HEX_KEY)
    // MY_SECRET is not valid hex, so it must be rejected even when resolved
    expect(secret.safeParse({ env: 'MY_SECRET' }).success).toBe(false)
  })

  test('applies the inner schema to file-resolved values', () => {
    const secret = ConfigSecret(z.hex().min(32).max(32))
    expect(secret.parse({ file: hexFile })).toBe(HEX_KEY)
    expect(secret.safeParse({ file: secretFile }).success).toBe(false)
  })

  test('exposes string | { env } | { file } as input and string as output', () => {
    const _secret = ConfigSecret()
    const _in1: z.input<typeof _secret> = 'literal'
    const _in2: z.input<typeof _secret> = { env: 'X' }
    const _in3: z.input<typeof _secret> = { file: '/run/secrets/x' }
    const _out: z.output<typeof _secret> = 'a-string'
    expect([_in1, _in2, _in3, _out]).toBeDefined()
  })
})

describe('appConfig parsing', () => {
  const savedEnv = { ...process.env }
  let headerSecretFile: string
  let jackSecretFile: string
  let radarrKeyFile: string
  let tempDir: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'jack-app-config-'))
    headerSecretFile = join(tempDir, 'header-secret')
    jackSecretFile = join(tempDir, 'jack-secret')
    radarrKeyFile = join(tempDir, 'radarr-key')

    writeFileSync(headerSecretFile, 'header-file-secret\n')
    writeFileSync(jackSecretFile, 'jack-file-secret\n')
    writeFileSync(radarrKeyFile, `${HEX_KEY}\n`)

    process.env.JACK_KEY = 'jack-secret'
    process.env.RADARR_KEY = HEX_KEY
    process.env.HEADER_SECRET = 'header-secret'
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
    process.env = { ...savedEnv }
  })

  test('parses a servers + peers config', () => {
    const parsed = AppConfig.parse({
      jack: { baseUrl: 'http://jack:3000', apiKey: 'jack-key' },
      servers: [
        { name: 'radarr', type: 'radarr', url: 'http://radarr:7878', apiKey: HEX_KEY },
      ],
      peers: [{ name: 'friend', url: 'http://peer:3000', apiKey: 'peer-key' }],
    })

    expect(parsed.jack?.apiKey).toBe('jack-key')
    expect(parsed.servers[0]?.apiKey).toBe(HEX_KEY)
    expect(parsed.servers[0]?.headers).toEqual({})
    expect(parsed.peers[0]?.apiKey).toBe('peer-key')
    expect(parsed.peers[0]?.headers).toEqual({})
  })

  test('defaults source/destination/autoregister', () => {
    const parsed = AppConfig.parse({
      servers: [{ name: 'radarr', type: 'radarr', url: 'http://radarr:7878', apiKey: HEX_KEY }],
    })

    const server = parsed.servers[0]!
    expect(server.source).toBe(true)
    expect(server.destination).toBe(true)
    expect(server.autoregister).toEqual({ enable: true, priority: 1 })
  })

  test('respects explicit source/destination/autoregister', () => {
    const parsed = AppConfig.parse({
      servers: [{
        name: 'sonarr',
        type: 'sonarr',
        url: 'http://sonarr:8989',
        apiKey: HEX_KEY,
        source: false,
        destination: true,
        autoregister: { enable: false, priority: 5 },
      }],
    })

    const server = parsed.servers[0]!
    expect(server.source).toBe(false)
    expect(server.destination).toBe(true)
    expect(server.autoregister).toEqual({ enable: false, priority: 5 })
  })

  test('defaults servers and peers to empty arrays', () => {
    const parsed = AppConfig.parse({})
    expect(parsed.servers).toEqual([])
    expect(parsed.peers).toEqual([])
  })

  test('resolves env-reference api keys into plain strings', () => {
    const parsed = AppConfig.parse({
      jack: { baseUrl: 'http://jack:3000', apiKey: { env: 'JACK_KEY' } },
      servers: [{ name: 'radarr', type: 'radarr', url: 'http://radarr:7878', apiKey: { env: 'RADARR_KEY' } }],
    })

    expect(parsed.jack?.apiKey).toBe('jack-secret')
    expect(parsed.servers[0]?.apiKey).toBe(HEX_KEY)
  })

  test('resolves file-reference api keys into plain strings', () => {
    const parsed = AppConfig.parse({
      jack: { baseUrl: 'http://jack:3000', apiKey: { file: jackSecretFile } },
      servers: [{ name: 'radarr', type: 'radarr', url: 'http://radarr:7878', apiKey: { file: radarrKeyFile } }],
    })

    expect(parsed.jack?.apiKey).toBe('jack-file-secret')
    expect(parsed.servers[0]?.apiKey).toBe(HEX_KEY)
  })

  test('resolves custom server and peer headers', () => {
    const parsed = AppConfig.parse({
      servers: [{
        name: 'radarr',
        type: 'radarr',
        url: 'http://radarr:7878',
        apiKey: HEX_KEY,
        headers: {
          'X-Literal': 'literal-header',
          'X-Secret': { env: 'HEADER_SECRET' },
          'X-Secret-File': { file: headerSecretFile },
        },
      }],
      peers: [{
        name: 'friend',
        url: 'http://peer:3000',
        apiKey: 'peer-key',
        headers: {
          'X-Peer-Secret': { env: 'HEADER_SECRET' },
          'X-Peer-Secret-File': { file: headerSecretFile },
        },
      }],
    })

    expect(parsed.servers[0]?.headers).toEqual({
      'X-Literal': 'literal-header',
      'X-Secret': 'header-secret',
      'X-Secret-File': 'header-file-secret',
    })
    expect(parsed.peers[0]?.headers).toEqual({
      'X-Peer-Secret': 'header-secret',
      'X-Peer-Secret-File': 'header-file-secret',
    })
  })

  test('keeps the hex constraint for env-resolved server keys', () => {
    process.env.BAD_HEX = 'too-short'
    const result = ServerConfig.safeParse({
      name: 'radarr',
      type: 'radarr',
      url: 'http://radarr:7878',
      apiKey: { env: 'BAD_HEX' },
    })
    expect(result.success).toBe(false)
  })

  test('requires a name on servers', () => {
    const result = ServerConfig.safeParse({
      type: 'radarr',
      url: 'http://radarr:7878',
      apiKey: HEX_KEY,
    })
    expect(result.success).toBe(false)
  })

  test('fails parsing when a referenced env var is missing', () => {
    delete process.env.JACK_KEY
    const result = JackConfig.safeParse({ baseUrl: 'http://jack:3000', apiKey: { env: 'JACK_KEY' } })
    expect(result.success).toBe(false)
  })

  test('fails parsing when a referenced header env var is missing', () => {
    delete process.env.HEADER_SECRET
    const result = PeerConfig.safeParse({
      name: 'friend',
      url: 'http://peer:3000',
      apiKey: 'peer-key',
      headers: { 'X-Secret': { env: 'HEADER_SECRET' } },
    })
    expect(result.success).toBe(false)
  })

  test('defaults the downloads hardening knobs', () => {
    const parsed = AppConfig.parse({
      downloads: { completedPath: '/c' },
    })
    expect(parsed.downloads).toMatchObject({
      maxConcurrentDownloads: 3,
      maxDownloadAttempts: 5,
      retryBaseDelayMs: 1000,
      retryMaxDelayMs: 60_000,
      idleTimeoutMs: 60_000,
    })
  })

  test('respects an explicit maxConcurrentDownloads and rejects non-positive values', () => {
    const parsed = AppConfig.parse({ downloads: { completedPath: '/c', maxConcurrentDownloads: 8 } })
    expect(parsed.downloads?.maxConcurrentDownloads).toBe(8)
    expect(AppConfig.safeParse({ downloads: { completedPath: '/c', maxConcurrentDownloads: 0 } }).success).toBe(false)
  })
})
