export const REDACTED = '[redacted]'

const SENSITIVE_FIELD_NAME = /(?:^|[-_.])(?:api[-_.]?key|authorization|cookie|password|secret|token)(?:$|[-_.])/i

export function isSensitiveField(name: string) {
  return SENSITIVE_FIELD_NAME.test(name)
}

export function redactRecord(record: Record<string, string | string[]>): Record<string, string | string[]> {
  return Object.fromEntries(
    Object.entries(record).map(([key, value]) => [key, isSensitiveField(key) ? REDACTED : value]),
  )
}
