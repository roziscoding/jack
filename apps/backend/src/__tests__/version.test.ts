import { describe, expect, test } from 'bun:test'
import { compareVersions, isPeerVersionCompatible, MIN_PEER_PROTOCOL_VERSION, SERVER_VERSION } from '../lib/version'

describe('compareVersions', () => {
  test('returns 0 for equal versions', () => {
    expect(compareVersions('0.1.0', '0.1.0')).toBe(0)
  })

  test('compares by major, then minor, then patch', () => {
    expect(compareVersions('1.0.0', '0.9.9')).toBe(1)
    expect(compareVersions('0.2.0', '0.1.9')).toBe(1)
    expect(compareVersions('0.1.2', '0.1.1')).toBe(1)
    expect(compareVersions('0.1.0', '0.2.0')).toBe(-1)
    expect(compareVersions('0.0.9', '0.1.0')).toBe(-1)
  })

  test('throws on a malformed version string', () => {
    expect(() => compareVersions('abc', '0.1.0')).toThrow('Invalid version string: "abc"')
    expect(() => compareVersions('0.1.0', '1.2')).toThrow('Invalid version string: "1.2"')
  })
})

describe('isPeerVersionCompatible', () => {
  test('accepts the minimum and anything above it', () => {
    expect(isPeerVersionCompatible(MIN_PEER_PROTOCOL_VERSION)).toBe(true)
    expect(isPeerVersionCompatible('0.1.0')).toBe(true)
    expect(isPeerVersionCompatible('1.0.0')).toBe(true)
  })

  test('rejects versions below the minimum', () => {
    expect(isPeerVersionCompatible('0.0.9')).toBe(false)
  })

  test('rejects malformed or empty versions', () => {
    expect(isPeerVersionCompatible('')).toBe(false)
    expect(isPeerVersionCompatible('nope')).toBe(false)
  })

  test('SERVER_VERSION is itself compatible', () => {
    expect(isPeerVersionCompatible(SERVER_VERSION)).toBe(true)
  })
})
