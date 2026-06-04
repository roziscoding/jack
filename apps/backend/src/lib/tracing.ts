import type { Attributes, AttributeValue, Span } from '@opentelemetry/api'
import { SpanStatusCode, trace } from '@opentelemetry/api'

type SpanAttributes = Record<string, AttributeValue | undefined>

const tracer = trace.getTracer('jack-backend')

function definedAttributes(attributes: SpanAttributes = {}): Attributes {
  return Object.fromEntries(
    Object.entries(attributes).filter((entry): entry is [string, AttributeValue] => entry[1] !== undefined),
  )
}

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
  return tracer.startActiveSpan(name, { attributes: definedAttributes(attributes) }, async (span) => {
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
