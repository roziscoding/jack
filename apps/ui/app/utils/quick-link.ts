import type { PeerInput } from '~/types/management'

const PREFIX = 'jack-link:v1:'
const MAX_QUICK_LINK_LENGTH = 32_768
const HEADER_NAME = /^[!#$%&'*+\-.^`|~\w]+$/
const BASE64URL = /^[\w-]+$/
const LINE_BREAK = /[\r\n]/
const RESERVED_HEADERS = new Set([
  'x-api-key',
  'host',
  'content-length',
  'connection',
  'transfer-encoding',
])
const DANGEROUS_KEYS = new Set(['__proto__', 'prototype', 'constructor'])

function fail(message = 'Invalid Jack quick link'): never {
  throw new Error(message)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function decodeBase64Url(encoded: string): string {
  if (!encoded || !BASE64URL.test(encoded) || encoded.length % 4 === 1)
    return fail()

  try {
    const base64 = encoded.replaceAll('-', '+').replaceAll('_', '/').padEnd(Math.ceil(encoded.length / 4) * 4, '=')
    const binary = atob(base64)
    const bytes = Uint8Array.from(binary, char => char.charCodeAt(0))
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  }
  catch {
    return fail()
  }
}

function parseHeaders(value: unknown): Record<string, string> {
  if (!isRecord(value))
    return fail()

  const entries = Object.entries(value)
  if (entries.length > 100)
    return fail()

  const headers: Record<string, string> = Object.create(null)
  const normalizedNames = new Set<string>()
  for (const [name, headerValue] of entries) {
    const lower = name.toLowerCase()
    if (
      normalizedNames.has(lower)
      || DANGEROUS_KEYS.has(lower)
      || RESERVED_HEADERS.has(lower)
      || !HEADER_NAME.test(name)
      || typeof headerValue !== 'string'
      || !headerValue
      || LINE_BREAK.test(headerValue)
    ) {
      return fail()
    }
    normalizedNames.add(lower)
    headers[name] = headerValue
  }
  return headers
}

export function decodeQuickLink(input: string): PeerInput {
  const quickLink = input.trim()
  if (quickLink.length > MAX_QUICK_LINK_LENGTH)
    return fail('Jack quick link is too large')
  if (!quickLink.startsWith(PREFIX))
    return fail()

  let payload: unknown
  try {
    payload = JSON.parse(decodeBase64Url(quickLink.slice(PREFIX.length)))
  }
  catch {
    return fail()
  }

  if (!isRecord(payload) || payload.v !== 1 || payload.type !== 'peer')
    return fail()
  if (typeof payload.name !== 'string' || !payload.name.trim())
    return fail()
  if (typeof payload.apiKey !== 'string' || !payload.apiKey)
    return fail()
  if (typeof payload.url !== 'string')
    return fail()

  let url: URL
  try {
    url = new URL(payload.url)
  }
  catch {
    return fail()
  }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password)
    return fail()

  const headers = parseHeaders(payload.headers)
  return {
    name: payload.name.trim(),
    url: payload.url,
    apiKey: payload.apiKey,
    ...(Object.keys(headers).length ? { headers } : {}),
  }
}
