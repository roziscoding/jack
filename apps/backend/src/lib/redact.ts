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
