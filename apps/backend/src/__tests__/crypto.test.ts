import { describe, expect, test } from 'bun:test'
import { constantTimeEqual } from '../lib/crypto'

describe('constantTimeEqual', () => {
  test('returns true for identical secrets', () => {
    expect(constantTimeEqual('jack_some_secret_value', 'jack_some_secret_value')).toBe(true)
  })

  test('returns false when a single byte differs', () => {
    expect(constantTimeEqual('jack_some_secret_value', 'jack_some_secret_valuX')).toBe(false)
  })

  test('returns false for different-length inputs without throwing', () => {
    expect(constantTimeEqual('short', 'a-considerably-longer-secret')).toBe(false)
  })

  test('treats two empty strings as equal', () => {
    expect(constantTimeEqual('', '')).toBe(true)
  })
})
