import type { Span } from '@opentelemetry/api'
import { SpanStatusCode, trace } from '@opentelemetry/api'
import { sanitizeAttributes } from './span-attributes'

// Values are unknown because they're sanitized (redacted/serialized) at creation
// time by `sanitizeAttributes` — the same funnel `setSpanAttribute` uses.
type SpanAttributes = Record<string, unknown>

const tracer = trace.getTracer('jack-backend')

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function recordSpanError(span: Span, err: unknown) {
  span.recordException(err instanceof Error ? err : String(err))
  span.setStatus({ code: SpanStatusCode.ERROR, message: errorMessage(err) })
}

export async function withSpan<T>(
  name: string,
  attributes: SpanAttributes,
  fn: (span: Span) => Promise<T> | T,
): Promise<T> {
  return tracer.startActiveSpan(name, { attributes: sanitizeAttributes(attributes) }, async (span) => {
    try {
      const result = await fn(span)
      span.setStatus({ code: SpanStatusCode.OK })
      return result
    }
    catch (err) {
      recordSpanError(span, err)
      throw err
    }
    finally {
      span.end()
    }
  })
}
