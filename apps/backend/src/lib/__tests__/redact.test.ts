import { describe, expect, test } from 'bun:test'
import { REDACTED, redactObject } from '../redact'

describe('redactObject', () => {
  test('masks string values under sensitive keys, keeping edges', () => {
    const result = redactObject({ authorization: 'Bearer super-secret-token-value' })
    expect(result.authorization).toBe('Bear…alue')
  })

  test('fully redacts sensitive strings too short to mask meaningfully', () => {
    expect(redactObject({ token: 'short' }).token).toBe(REDACTED)
  })

  test('leaves non-sensitive fields untouched', () => {
    const input = { userId: 42, action: 'login', nested: { count: 1 } }
    expect(redactObject(input)).toEqual(input)
  })

  test('recurses into nested objects and arrays', () => {
    const result = redactObject({
      request: {
        headers: { cookie: 'session=abcdefghijklmnop' },
        body: { ok: true },
      },
      items: [{ apiKey: 'abcdefghijklmnop' }, { id: 7 }],
    })
    expect(result).toEqual({
      request: {
        headers: { cookie: 'sess…mnop' },
        body: { ok: true },
      },
      items: [{ apiKey: 'abcd…mnop' }, { id: 7 }],
    })
  })

  test('hides non-string values under sensitive keys entirely', () => {
    expect(redactObject<Record<string, unknown>>({ password: { hash: 'x' } }).password).toBe(REDACTED)
    expect(redactObject<Record<string, unknown>>({ secret: 12345 }).secret).toBe(REDACTED)
  })

  test('masks each element of a sensitive array', () => {
    const result = redactObject({ token: ['abcdefghijklmnop', 'short'] })
    expect(result.token).toEqual(['abcd…mnop', REDACTED])
  })
})
