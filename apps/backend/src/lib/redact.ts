export const REDACTED = '[redacted]'

const SENSITIVE_FIELD_NAME = /(?:^|[-_.])(?:api[-_.]?key|authorization|cookie|password|secret|token)(?:$|[-_.])/i

// Keep a few chars on each end so a mis-pasted secret is still diagnosable
// (wrong value, swapped fields, stray whitespace) without revealing enough to
// be useful. Anything too short to mask meaningfully is hidden entirely.
const VISIBLE_EDGE = 4
const MIN_MASKABLE_LENGTH = VISIBLE_EDGE * 2 + 4

export function isSensitiveField(name: string) {
  return SENSITIVE_FIELD_NAME.test(name)
}

export function redactValue(value: string): string {
  if (value.length < MIN_MASKABLE_LENGTH) {
    return REDACTED
  }
  return `${value.slice(0, VISIBLE_EDGE)}…${value.slice(-VISIBLE_EDGE)}`
}

export function redactIfSensitive(key: string, value: string | string[]): string | string[] {
  if (!isSensitiveField(key)) {
    return value
  }
  return Array.isArray(value) ? value.map(redactValue) : redactValue(value)
}

export function redactRecord(record: Record<string, string | string[]>): Record<string, string | string[]> {
  return Object.fromEntries(
    Object.entries(record).map(([key, value]) => [key, redactIfSensitive(key, value)]),
  )
}

// Mask a value that lives under a sensitive key, whatever its shape: strings get
// the edge-preserving mask, arrays are masked element-wise, and anything else
// (numbers, nested objects) is hidden entirely since we can't safely show any of it.
function maskSensitiveValue(value: unknown): unknown {
  if (typeof value === 'string') {
    return redactValue(value)
  }
  if (Array.isArray(value)) {
    return value.map(maskSensitiveValue)
  }
  if (value === null || value === undefined) {
    return value
  }
  return REDACTED
}

// Recursively redact sensitive fields anywhere in an arbitrary value, leaving the
// surrounding structure intact. Used to scrub log records before they're emitted.
export function redactObject<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map(item => redactObject(item)) as T
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, val]) => [
        key,
        isSensitiveField(key) ? maskSensitiveValue(val) : redactObject(val),
      ]),
    ) as T
  }
  return value
}
