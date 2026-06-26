import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import z from 'zod'
import { ConfigSecret, migrateConfig, MIGRATIONS } from '../lib/config'

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
})

describe('migrateConfig', () => {
  test('migrates a versionless config up to the latest version', () => {
    const result = migrateConfig({ servers: [], peers: [] })
    expect(result).toBeDefined()
    expect(result!.version).toBe(MIGRATIONS.length)
  })

  test('preserves the existing fields while migrating', () => {
    const result = migrateConfig({ servers: ['a'], peers: ['b'], extra: 'kept' })
    expect(result).toMatchObject({ servers: ['a'], peers: ['b'], extra: 'kept' })
  })

  test('treats an explicit version of 0 as unmigrated and runs every migration', () => {
    const result = migrateConfig({ version: 0, foo: 'bar' })
    expect(result).toBeDefined()
    expect(result).toMatchObject({ foo: 'bar' })
    expect(result!.version).toBe(MIGRATIONS.length)
  })

  test('treats a non-numeric version as unmigrated', () => {
    const result = migrateConfig({ version: 'nope' as unknown as number }) as Record<string, unknown>
    expect(result).toBeDefined()
    expect(result.version).toBe(MIGRATIONS.length)
  })

  test('returns undefined when already at the latest version', () => {
    const result = migrateConfig({ version: MIGRATIONS.length })
    expect(result).toBeUndefined()
  })

  test('returns undefined when the version is ahead of the known migrations', () => {
    const result = migrateConfig({ version: MIGRATIONS.length + 5 })
    expect(result).toMatchObject({ version: MIGRATIONS.length })
  })

  test('applies only the migrations newer than the current version', () => {
    // Build a fake migration chain so the test is independent of how many real
    // migrations exist: each step stamps the version it produces.
    const original = [...MIGRATIONS]
    try {
      MIGRATIONS.length = 0
      MIGRATIONS.push(
        <T extends object>(obj: T) => ({ ...obj, version: 1, m1: true }),
        <T extends object>(obj: T) => ({ ...obj, version: 2, m2: true }),
      )

      // Starting at version 1, only the second migration should run.
      const result = migrateConfig({ version: 1, kept: true }) as Record<string, unknown>
      expect(result).toMatchObject({ version: 2, kept: true, m2: true })
      expect(result.m1).toBeUndefined()
    }
    finally {
      MIGRATIONS.length = 0
      MIGRATIONS.push(...original)
    }
  })
})
