import { describe, expect, test } from 'bun:test'
import { decodeQuickLink } from './quick-link'

function base64Url(text: string): string {
  const binary = String.fromCharCode(...new TextEncoder().encode(text))
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

function link(payload: unknown): string {
  return `jack-link:v1:${base64Url(JSON.stringify(payload))}`
}

const validPayload = {
  v: 1,
  type: 'peer',
  name: 'Amigo’s Jack',
  url: 'https://jack.friend.example',
  apiKey: 'jack_test_key',
  headers: { 'CF-Access-Client-Id': 'client-id' },
}

describe('decodeQuickLink', () => {
  test('decodes UTF-8 and returns a PeerInput', () => {
    expect(decodeQuickLink(link(validPayload))).toEqual({
      name: 'Amigo’s Jack',
      url: 'https://jack.friend.example',
      apiKey: 'jack_test_key',
      headers: { 'CF-Access-Client-Id': 'client-id' },
    })
  })

  test.each([
    ['wrong prefix', 'https://jack.friend.example'],
    ['unsupported version', link({ ...validPayload, v: 2 })],
    ['unsupported type', link({ ...validPayload, type: 'server' })],
    ['invalid URL scheme', link({ ...validPayload, url: 'file:///etc/passwd' })],
    ['URL username credentials', link({ ...validPayload, url: 'https://user@jack.friend.example' })],
    ['URL password credentials', link({ ...validPayload, url: 'https://user:password@jack.friend.example' })],
    ['empty API key', link({ ...validPayload, apiKey: '' })],
    ['non-string header', link({ ...validPayload, headers: { Test: 42 } })],
    ['reserved API key header', link({ ...validPayload, headers: { 'x-api-key': 'override' } })],
    ['hop-by-hop header', link({ ...validPayload, headers: { Connection: 'close' } })],
    ['header value with line breaks', link({ ...validPayload, headers: { Authorization: 'safe\r\nInjected: value' } })],
    ['case-insensitive duplicate headers', link({ ...validPayload, headers: { Authorization: 'first', authorization: 'second' } })],
  ])('rejects %s', (_case, input) => {
    expect(() => decodeQuickLink(input)).toThrow()
  })

  test('rejects prototype-pollution header keys', () => {
    const encoded = base64Url('{"v":1,"type":"peer","name":"Jack","url":"https://jack.test","apiKey":"key","headers":{"__proto__":"pollute"}}')
    expect(() => decodeQuickLink(`jack-link:v1:${encoded}`)).toThrow()
  })

  test('rejects malformed and oversized input without echoing the secret', () => {
    const secret = 'do-not-repeat-me'
    expect(() => decodeQuickLink(`jack-link:v1:${secret}`)).toThrow(Error)
    try {
      decodeQuickLink(`jack-link:v1:${secret}`)
    }
    catch (error) {
      expect(String(error)).not.toContain(secret)
    }
    expect(() => decodeQuickLink(`jack-link:v1:${'a'.repeat(40_000)}`)).toThrow('too large')
  })
})
