import type { Attributes, AttributeValue, Span } from '@opentelemetry/api'
import { isSensitiveField, REDACTED, redactObject, redactValue } from './redact'

// The single funnel for putting data on a span. Every attribute the app sets
// goes through here so redaction, serialization, and truncation happen in one
// place — call sites never touch `span.setAttribute` directly (a lint rule
// enforces this). OTel only accepts primitives and homogeneous primitive arrays
// as attribute values, so anything richer is redacted and JSON-serialized here.

// Final guard on attribute size. Distinct from the capture-time body cap in the
// request logger (which bounds memory while reading a stream); this one bounds
// the serialized attribute regardless of where the value came from.
const MAX_ATTRIBUTE_VALUE_LENGTH = 8 * 1024

function capString(value: string): string {
  return value.length <= MAX_ATTRIBUTE_VALUE_LENGTH
    ? value
    : `${value.slice(0, MAX_ATTRIBUTE_VALUE_LENGTH)}…`
}

function maskString(key: string, value: string): string {
  return capString(isSensitiveField(key) ? redactValue(value) : value)
}

// Turn an arbitrary value into something OTel can store, redacting on the way.
// Returns undefined when there's nothing to set (so the attribute is skipped).
function sanitizeAttributeValue(key: string, value: unknown): AttributeValue | undefined {
  if (value === undefined || value === null) {
    return undefined
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return value
  }
  if (typeof value === 'string') {
    return maskString(key, value)
  }
  if (Array.isArray(value)) {
    // Homogeneous primitive arrays are valid attribute values as-is.
    if (value.every(item => typeof item === 'string')) {
      return value.map(item => maskString(key, item))
    }
    if (value.every(item => typeof item === 'number') || value.every(item => typeof item === 'boolean')) {
      return value as number[] | boolean[]
    }
    // Otherwise (objects, mixed) fall through to JSON serialization below.
  }
  // Objects / complex arrays: a sensitive key means the whole thing is secret;
  // anything else gets deep field-level redaction before serialization.
  if (isSensitiveField(key)) {
    return REDACTED
  }
  return capString(JSON.stringify(redactObject(value)))
}

/**
 * Set a single span attribute, redacting/serializing/truncating its value.
 * Use this instead of `span.setAttribute`.
 */
export function setSpanAttribute(span: Span, key: string, value: unknown): void {
  const sanitized = sanitizeAttributeValue(key, value)
  if (sanitized === undefined) {
    return
  }

  span.setAttribute(key, sanitized)
}

/**
 * Set many span attributes at once. Use this instead of `span.setAttributes`.
 */
export function setSpanAttributes(span: Span, record: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(record)) {
    setSpanAttribute(span, key, value)
  }
}

/**
 * Sanitize an attribute record for use at span *creation* time (where there's no
 * span handle yet to call setSpanAttribute on), e.g. the attributes passed to
 * `withSpan`. Drops keys whose value sanitizes to nothing.
 */
export function sanitizeAttributes(record: Record<string, unknown>): Attributes {
  const result: Attributes = {}
  for (const [key, value] of Object.entries(record)) {
    const sanitized = sanitizeAttributeValue(key, value)
    if (sanitized !== undefined) {
      result[key] = sanitized
    }
  }
  return result
}

/**
 * Mask only sensitive *query-parameter values* in a URL, leaving scheme, host,
 * path, and non-sensitive params intact so the URL stays debuggable. Returns the
 * input unchanged (same reference semantics — identical string) when there's
 * nothing sensitive to mask, so callers can skip writing when nothing changed.
 */
export function redactUrl(rawUrl: string): string {
  let url: URL
  try {
    url = new URL(rawUrl)
  }
  catch {
    return rawUrl
  }

  const entries = [...url.searchParams.entries()]
  if (!entries.some(([key]) => isSensitiveField(key))) {
    return rawUrl
  }

  // Rebuild the query in place so parameter order is preserved.
  url.search = ''
  for (const [key, value] of entries) {
    url.searchParams.append(key, isSensitiveField(key) ? redactValue(value) : value)
  }
  return url.toString()
}
