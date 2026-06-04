import type { LogAttributes } from '@opentelemetry/api-logs'
import process from 'node:process'
import { trace } from '@opentelemetry/api'
import { logs, SeverityNumber } from '@opentelemetry/api-logs'
import { levels, multistream, pino } from 'pino'
import { getAppEnvs, isOtelEnabled } from './lib/envs'

const envs = getAppEnvs()
const otelEnabled = isOtelEnabled(envs)

// pino numeric level -> OpenTelemetry severity number.
const PINO_LEVEL_TO_SEVERITY: Record<number, SeverityNumber> = {
  10: SeverityNumber.TRACE,
  20: SeverityNumber.DEBUG,
  30: SeverityNumber.INFO,
  40: SeverityNumber.WARN,
  50: SeverityNumber.ERROR,
  60: SeverityNumber.FATAL,
}

const logFormatters = {
  level(label: string, level: number) {
    return { level, severity: label }
  },
}

// Tie logs to traces: stamp each log with the active span's ids. Runs in the
// main thread on every log, so the request span (set by the @hono/otel
// middleware) is current. Returns nothing when there's no active span.
function traceContextMixin() {
  const span = trace.getActiveSpan()
  if (!span)
    return { environment: envs.ENVIRONMENT }
  const { traceId, spanId, traceFlags } = span.spanContext()
  return { environment: envs.ENVIRONMENT, trace_id: traceId, span_id: spanId, trace_flags: traceFlags.toString(16) }
}

// In-process bridge from pino to the OpenTelemetry Logs API. Each finished pino
// line is parsed and re-emitted as an OTel LogRecord. Because this runs
// synchronously in the main thread during the log call, the request's active
// span is still current and gets attached to the record natively — so logs and
// traces correlate without extra backend config. The logger is resolved lazily
// so it picks up the global provider instrumentation.ts registers at startup.
const otelLogStream = {
  write(line: string) {
    let record: Record<string, unknown>
    try {
      record = JSON.parse(line) as Record<string, unknown>
    }
    catch {
      return
    }

    const level = typeof record.level === 'number' ? record.level : 30

    // Everything that isn't a standard pino field becomes a log attribute. The
    // trace ids are dropped — the active span is attached natively below.
    const attributes = { ...record }
    for (const key of ['time', 'level', 'severity', 'message', 'msg', 'hostname', 'pid', 'trace_id', 'span_id', 'trace_flags'])
      delete attributes[key]

    const body = typeof record.message === 'string'
      ? record.message
      : typeof record.msg === 'string'
        ? record.msg
        : undefined

    logs.getLogger(envs.OTEL_SERVICE_NAME).emit({
      timestamp: typeof record.time === 'number' ? record.time : undefined,
      severityNumber: PINO_LEVEL_TO_SEVERITY[level] ?? SeverityNumber.UNSPECIFIED,
      severityText: levels.labels[level],
      body,
      attributes: attributes as LogAttributes,
    })
  },
}

// With tracing on, fan out to stdout (raw JSON) and the OTel bridge via an
// in-process multistream — no worker thread, which `thread-stream` transports
// don't survive under Bun. With tracing off, keep the original path:
// pretty-printed in dev, plain synchronous stdout in production.
function getLogger() {
  if (!otelEnabled) {
    return pino({
      enabled: envs.ENABLE_LOGS,
      level: envs.LOG_LEVEL,
      messageKey: 'message',
      formatters: logFormatters,
      mixin: traceContextMixin,
      transport: envs.ENVIRONMENT !== 'production'
        ? {
            target: 'pino-pretty',
            options: {
              colorize: true,
              singleLine: true,
              messageKey: 'message',
              ignore: 'pid,hostname,severity',
            },
          }
        : undefined,
    })
  }

  return pino(
    {
      enabled: envs.ENABLE_LOGS,
      level: envs.LOG_LEVEL,
      messageKey: 'message',
      formatters: logFormatters,
      mixin: traceContextMixin,
    },
    multistream([
      { stream: process.stdout, level: envs.LOG_LEVEL },
      { stream: otelLogStream, level: envs.LOG_LEVEL },
    ]),
  )
}

export const logger = getLogger()
