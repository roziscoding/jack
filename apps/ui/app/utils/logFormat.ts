import type { LogRecord } from '~/types/management'

// Keys that carry structural meaning and are rendered in dedicated columns, so
// they're excluded from the "extra fields" detail dump.
const RESERVED = new Set([
  '_id',
  '_count',
  '_durations',
  'time',
  'level',
  'severity',
  'message',
  'msg',
  'pid',
  'hostname',
])

export type LevelKey = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal'

const LEVEL_KEYS = new Set<string>(['trace', 'debug', 'info', 'warn', 'error', 'fatal'])

// Prefer the string `severity`, but only when it's a label we can style — an
// unrecognised one (a custom level like `critical`) would miss LEVEL_STYLES and
// mis-render as INFO, hiding a high-priority line. Fall through to the numeric
// pino level in that case rather than trusting the string blindly.
export function levelName(record: LogRecord): LevelKey {
  const severity = typeof record.severity === 'string' ? record.severity.toLowerCase() : undefined
  if (severity && LEVEL_KEYS.has(severity))
    return severity as LevelKey
  const l = typeof record.level === 'number' ? record.level : 30
  return l >= 60 ? 'fatal' : l >= 50 ? 'error' : l >= 40 ? 'warn' : l >= 30 ? 'info' : l >= 20 ? 'debug' : 'trace'
}

export interface LevelStyle {
  label: string
  // Colour of the level word itself.
  text: string
  // Left rail: lit only for warn+ so anomalies surface out of the trace flood.
  rail: string
}

const LEVEL_STYLES: Record<LevelKey, LevelStyle> = {
  trace: { label: 'TRACE', text: 'text-dimmed', rail: 'border-l-transparent' },
  debug: { label: 'DEBUG', text: 'text-dimmed', rail: 'border-l-transparent' },
  info: { label: 'INFO', text: 'text-muted', rail: 'border-l-transparent' },
  warn: { label: 'WARN', text: 'text-warning', rail: 'border-l-warning' },
  error: { label: 'ERROR', text: 'text-error', rail: 'border-l-error' },
  fatal: { label: 'FATAL', text: 'text-error', rail: 'border-l-error' },
}

export function levelStyle(record: LogRecord): LevelStyle {
  // A severity string we can't map (a custom level like `critical`) with no
  // numeric level would otherwise fall to INFO and hide. Show its own label with
  // a lit rail so it can't pass as a normal line — we can't rank it, so treat it
  // as noteworthy rather than silently benign.
  const severity = typeof record.severity === 'string' ? record.severity.trim() : ''
  if (severity && !LEVEL_KEYS.has(severity.toLowerCase()) && typeof record.level !== 'number')
    return { label: severity.toUpperCase(), text: 'text-warning', rail: 'border-l-warning' }
  return LEVEL_STYLES[levelName(record)] ?? LEVEL_STYLES.info
}

export interface HttpInfo {
  method: string
  path: string
  status?: number
}

// A request log carries an `http.request.method` — everything else falls through
// to the plain message renderer.
export function extractHttp(record: LogRecord): HttpInfo | null {
  const http = record.http as { request?: { method?: unknown, path?: unknown }, response?: { status?: unknown } } | undefined
  if (!http || typeof http !== 'object')
    return null
  const method = http.request?.method
  if (typeof method !== 'string')
    return null
  return {
    method,
    path: typeof http.request?.path === 'string' ? http.request.path : '',
    status: typeof http.response?.status === 'number' ? http.response.status : undefined,
  }
}

// HTTP verbs coloured like a network inspector: read=blue, create=green,
// mutate=amber, destroy=red. Kept subtle so status/latency anomalies dominate.
export function methodClass(method: string): string {
  switch (method.toUpperCase()) {
    case 'GET': return 'text-info'
    case 'POST': return 'text-success'
    case 'PUT':
    case 'PATCH': return 'text-warning'
    case 'DELETE': return 'text-error'
    default: return 'text-muted'
  }
}

export function statusClass(status: number | undefined): string {
  if (status == null)
    return 'text-dimmed'
  if (status >= 500)
    return 'text-error'
  if (status >= 400)
    return 'text-warning'
  if (status >= 300)
    return 'text-info'
  if (status >= 200)
    return 'text-success'
  return 'text-muted'
}

export function latencyClass(ms: number): string {
  if (ms >= 500)
    return 'text-error'
  if (ms >= 100)
    return 'text-warning'
  if (ms >= 20)
    return 'text-toned'
  return 'text-dimmed'
}

// Compact, human duration. Sub-10ms keeps one decimal (the common request case),
// everything else rounds; past a second it flips to seconds.
export function formatMs(ms: number): string {
  if (!Number.isFinite(ms))
    return ''
  if (ms >= 1000)
    return `${(ms / 1000).toFixed(2)}s`
  if (ms >= 10)
    return `${Math.round(ms)}ms`
  return `${ms.toFixed(1)}ms`
}

// Micro-bar fill, 0-100. Log-scaled against a fixed 500ms reference so bars stay
// comparable across the whole stream (a spike always reads as a spike) and a
// 1ms request still shows a visible nub instead of nothing.
const LAT_REF = Math.log10(501)
export function latencyFill(ms: number): number {
  if (!(ms > 0))
    return 0
  const pct = (Math.log10(ms + 1) / LAT_REF) * 100
  return Math.max(4, Math.min(100, pct))
}

// Colour for the micro-bar track (matches the latency thresholds, but as a fill).
export function latencyBarClass(ms: number): string {
  if (ms >= 500)
    return 'bg-error'
  if (ms >= 100)
    return 'bg-warning'
  if (ms >= 20)
    return 'bg-info'
  return 'bg-muted'
}

// HH:MM:SS.mmm — millisecond precision matters when dozens of lines share a second.
export function clockTime(time: unknown): string {
  if (typeof time !== 'number')
    return ''
  const d = new Date(time)
  if (Number.isNaN(d.getTime()))
    return ''
  const p2 = (n: number) => String(n).padStart(2, '0')
  return `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, '0')}`
}

// Signature that folds consecutive repeats: same level + message + request shape,
// ignoring per-occurrence noise (time, trace ids, duration). Non-request repeats
// fold on their full extra-field payload so distinct warnings never merge.
export function groupKey(record: LogRecord): string {
  const level = levelName(record)
  const http = extractHttp(record)
  if (http)
    return `h|${level}|${record.message ?? ''}|${http.method} ${http.path} ${http.status ?? ''}`
  const extra: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(record)) {
    if (RESERVED.has(k) || k === 'trace_id' || k === 'span_id' || k === 'trace_flags')
      continue
    extra[k] = v
  }
  return `m|${level}|${record.message ?? ''}|${JSON.stringify(extra)}`
}

// Flattened key -> stringified value for the detail panel. Nested objects (the
// `http` block) become dotted paths; everything is presented, nothing hidden.
export function extraFields(record: LogRecord): Array<{ key: string, value: string }> {
  const out: Array<{ key: string, value: string }> = []
  const walk = (obj: Record<string, unknown>, prefix: string) => {
    for (const [k, v] of Object.entries(obj)) {
      if (!prefix && RESERVED.has(k))
        continue
      const key = prefix ? `${prefix}.${k}` : k
      if (v && typeof v === 'object' && !Array.isArray(v))
        walk(v as Record<string, unknown>, key)
      else
        out.push({ key, value: typeof v === 'string' ? v : JSON.stringify(v) })
    }
  }
  walk(record, '')
  return out
}

// Full record as pretty JSON for the raw view / copy, minus our internal tags.
export function rawJson(record: LogRecord): string {
  const clean: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(record)) {
    if (k === '_id' || k === '_count' || k === '_durations')
      continue
    clean[k] = v
  }
  return JSON.stringify(clean, null, 2)
}
