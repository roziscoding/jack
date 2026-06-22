import type { Attributes, AttributeValue } from '@opentelemetry/api'
import { describe, expect, test } from 'bun:test'
import { REDACTED } from '../redact'
import { redactUrl, sanitizeAttributes, setSpanAttribute } from '../span-attributes'

// Minimal span stub that records what setSpanAttribute writes.
function fakeSpan() {
  const attributes: Attributes = {}
  return {
    attributes,
    setAttribute(key: string, value: AttributeValue) {
      attributes[key] = value
      return this
    },
  }
}

function setOne(key: string, value: unknown): AttributeValue | undefined {
  const span = fakeSpan()
  setSpanAttribute(span as never, key, value)
  return span.attributes[key]
}

describe('setSpanAttribute', () => {
  test('passes scalars through untouched', () => {
    expect(setOne('release.count', 42)).toBe(42)
    expect(setOne('range.satisfiable', true)).toBe(true)
    expect(setOne('url.path', '/torznab/api')).toBe('/torznab/api')
  })

  test('skips null/undefined entirely', () => {
    const span = fakeSpan()
    setSpanAttribute(span as never, 'a', undefined)
    setSpanAttribute(span as never, 'b', null)
    expect(Object.keys(span.attributes)).toHaveLength(0)
  })

  test('masks a string under a sensitive key', () => {
    expect(setOne('http.request.header.authorization', 'Bearer super-secret-token')).toBe('Bear…oken')
  })

  test('masks each element of a sensitive string array', () => {
    expect(setOne('x-api-key', ['abcdefghijklmnop', 'short'])).toEqual(['abcd…mnop', REDACTED])
  })

  test('serializes objects to JSON with nested fields redacted', () => {
    const value = setOne('http.request.headers', { 'content-type': 'application/json', 'authorization': 'abcdefghijklmnop' })
    expect(value).toBe(JSON.stringify({ 'content-type': 'application/json', 'authorization': 'abcd…mnop' }))
  })

  test('fully redacts an object that sits under a sensitive key', () => {
    expect(setOne('authorization', { scheme: 'Bearer', value: 'x' })).toBe(REDACTED)
  })

  test('truncates oversized strings', () => {
    const big = 'a'.repeat(10_000)
    const value = setOne('http.response.body', big) as string
    expect(value.length).toBe(8 * 1024 + 1) // capped slice + ellipsis
    expect(value.endsWith('…')).toBe(true)
  })
})

describe('sanitizeAttributes', () => {
  test('sanitizes a record and drops undefined-valued keys', () => {
    const result = sanitizeAttributes({
      'connector.name': 'sonarr',
      'http.request.headers': { authorization: 'abcdefghijklmnop' },
      'url.query': undefined,
    })
    expect(result).toEqual({
      'connector.name': 'sonarr',
      'http.request.headers': JSON.stringify({ authorization: 'abcd…mnop' }),
    })
  })
})

describe('redactUrl', () => {
  test('returns the input unchanged when no query param is sensitive', () => {
    const url = 'https://tracker.test/api?t=search&q=dune&season=1'
    expect(redactUrl(url)).toBe(url)
  })

  test('masks only sensitive param values, preserving order and the rest', () => {
    const result = redactUrl('https://tracker.test/api?t=search&apikey=abcdefghijklmnop&q=dune')
    expect(result).toBe('https://tracker.test/api?t=search&apikey=abcd%E2%80%A6mnop&q=dune')
  })

  test('leaves a non-URL string untouched', () => {
    expect(redactUrl('not a url')).toBe('not a url')
  })
})
