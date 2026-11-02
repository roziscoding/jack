import { describe, expect, test } from 'bun:test'
import { parseQueryValue, serializeQueryValue } from './useQueryString'

describe('parseQueryValue', () => {
  test('falls back to the default when the key is missing', () => {
    expect(parseQueryValue(undefined, 'all')).toBe('all')
    expect(parseQueryValue(undefined, false)).toBe(false)
    expect(parseQueryValue(undefined, 3)).toBe(3)
    expect(parseQueryValue(undefined, ['a'])).toEqual(['a'])
  })

  test('parses each type from the raw value', () => {
    expect(parseQueryValue('tv', 'all')).toBe('tv')
    expect(parseQueryValue('true', false)).toBe(true)
    expect(parseQueryValue('0', true)).toBe(false)
    expect(parseQueryValue('42', 0)).toBe(42)
    expect(parseQueryValue('p1', [])).toEqual(['p1'])
    expect(parseQueryValue(['p1', 'p2'], [])).toEqual(['p1', 'p2'])
  })

  test('ignores values that do not fit the default type', () => {
    expect(parseQueryValue('yes', false)).toBe(false)
    expect(parseQueryValue('abc', 7)).toBe(7)
  })
})

describe('serializeQueryValue', () => {
  test('drops the key when the value equals the default', () => {
    expect(serializeQueryValue('', '')).toBeUndefined()
    expect(serializeQueryValue(false, false)).toBeUndefined()
    expect(serializeQueryValue([], [])).toBeUndefined()
  })

  test('serializes values that differ from the default', () => {
    expect(serializeQueryValue('matrix', '')).toBe('matrix')
    expect(serializeQueryValue(true, false)).toBe('true')
    expect(serializeQueryValue(['p1', 'p2'], [])).toEqual(['p1', 'p2'])
  })
})
