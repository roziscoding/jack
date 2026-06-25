import { describe, expect, test } from 'bun:test'
import { API_KEY_PREFIX, generateApiKey, generateManagedKey, hashKey, isGeneratedKey, isManagedKey } from './crypto'

describe('crypto', () => {
  describe('hashKey', () => {
    test('returns hex SHA-256 hash', () => {
      const hash = hashKey('test-key')

      expect(hash).toHaveLength(64)
      expect(hash).toMatch(/^[a-f0-9]+$/)
    })

    test('same input produces same hash', () => {
      const hash1 = hashKey('same-key')
      const hash2 = hashKey('same-key')

      expect(hash1).toBe(hash2)
    })

    test('different inputs produce different hashes', () => {
      const hash1 = hashKey('key-one')
      const hash2 = hashKey('key-two')

      expect(hash1).not.toBe(hash2)
    })
  })

  describe('generateApiKey', () => {
    test('returns key with jack_ prefix', () => {
      const key = generateApiKey()

      expect(key.startsWith(API_KEY_PREFIX)).toBe(true)
    })

    test('returns key with 69 total characters (jack_ + 64 hex)', () => {
      const key = generateApiKey()

      expect(key).toHaveLength(69)
    })

    test('generates unique keys', () => {
      const key1 = generateApiKey()
      const key2 = generateApiKey()

      expect(key1).not.toBe(key2)
    })
  })

  describe('isGeneratedKey', () => {
    test('returns true for jack_ prefixed keys', () => {
      expect(isGeneratedKey('jack_abc123')).toBe(true)
    })

    test('returns false for other keys', () => {
      expect(isGeneratedKey('other_key')).toBe(false)
      expect(isGeneratedKey('abc123')).toBe(false)
    })
  })

  describe('managed key prefix dispatch', () => {
    test('a managed key is managed, not generated', () => {
      const key = generateManagedKey()
      expect(key.startsWith('jack_managed_')).toBe(true)
      expect(isManagedKey(key)).toBe(true)
      expect(isGeneratedKey(key)).toBe(false)
    })

    test('a user key is generated, not managed', () => {
      const key = generateApiKey()
      expect(isGeneratedKey(key)).toBe(true)
      expect(isManagedKey(key)).toBe(false)
    })
  })
})
