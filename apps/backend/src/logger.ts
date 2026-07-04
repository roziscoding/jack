import type { LogAttributes } from '@opentelemetry/api-logs'
import type { DestinationStream, StreamEntry } from 'pino'
import { createRequire } from 'node:module'
import process from 'node:process'
import { trace } from '@opentelemetry/api'
import { logs, SeverityNumber } from '@opentelemetry/api-logs'
import { levels, multistream, pino } from 'pino'
import { getAppEnvs, isOtelEnabled } from './lib/envs'
import { redactObject } from './lib/redact'
import { fileSink, logHub } from './modules/logging/log-store'

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
  // Runs on the fully-merged record just before serialization, so it scrubs
  // sensitive values regardless of where they entered the log (bindings, mixin,
  // or the logged object itself) — something a mixin can't do, since its fields
  // are overridden by the logged object rather than the other way around.
  log(object: Record<string, unknown>) {
    return redactObject(object)
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

// Console destination. In production it's plain synchronous stdout (raw JSON); in
// dev it's pino-pretty used as an *in-process* stream (no worker thread, which
// `thread-stream` transports don't survive under Bun). pino-pretty is a dev-only
// dependency, so it's required lazily — production never hits this branch.
function consoleStream(): DestinationStream {
  if (envs.ENVIRONMENT === 'production')
    return process.stdout
  const nodeRequire = createRequire(import.meta.url)
  const pretty = nodeRequire('pino-pretty') as (opts: Record<string, unknown>) => DestinationStream
  return pretty({ colorize: true, singleLine: true, messageKey: 'message', ignore: 'pid,hostname,severity' })
}

// Everything fans out through one in-process multistream: console, the rotating
// log file (persistence + the UI's backfill), the live SSE hub, and — when tracing
// is on — the OTel bridge. No worker threads anywhere.
function getLogger() {
  const streams: StreamEntry[] = [
    { stream: consoleStream(), level: envs.LOG_LEVEL },
  ]
  if (otelEnabled)
    streams.push({ stream: otelLogStream, level: envs.LOG_LEVEL })
  if (fileSink)
    streams.push({ stream: fileSink, level: envs.LOG_LEVEL })
  streams.push({ stream: logHub, level: envs.LOG_LEVEL })

  return pino(
    {
      enabled: envs.ENABLE_LOGS,
      level: envs.LOG_LEVEL,
      messageKey: 'message',
      formatters: logFormatters,
      mixin: traceContextMixin,
    },
    multistream(streams),
  )
}

export const logger = getLogger()
