import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import z from 'zod'
import { AppConfig, ConfigSecret, JackConfig, ServerConfig } from '../lib/config'

const HEX_KEY = '0123456789abcdef0123456789abcdef'

describe('configSecret', () => {
  const savedEnv = { ...process.env }

  beforeEach(() => {
    process.env.MY_SECRET = 'super-secret'
    process.env.MY_HEX = HEX_KEY
    delete process.env.UNSET_SECRET
  })

  afterEach(() => {
    process.env = { ...savedEnv }
  })

  test('passes a plain string through unchanged', () => {
    expect(ConfigSecret().parse('plain-value')).toBe('plain-value')
  })

  test('resolves an { env } reference from the environment', () => {
    expect(ConfigSecret().parse({ env: 'MY_SECRET' })).toBe('super-secret')
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

  test('rejects an empty plain string by default', () => {
    expect(ConfigSecret().safeParse('').success).toBe(false)
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

  test('exposes string | { env } as input and string as output', () => {
    const secret = ConfigSecret()
    const _in1: z.input<typeof secret> = 'literal'
    const _in2: z.input<typeof secret> = { env: 'X' }
    const _out: z.output<typeof secret> = 'a-string'
    expect([_in1, _in2, _out]).toBeDefined()
  })
})

describe('appConfig parsing', () => {
  beforeEach(() => {
    process.env.JACK_KEY = 'jack-secret'
    process.env.RADARR_KEY = HEX_KEY
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
    expect(parsed.peers[0]?.apiKey).toBe('peer-key')
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
})
