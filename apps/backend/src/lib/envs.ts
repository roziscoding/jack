import { z } from 'zod'

function preferPrefixedManagementKey(input: unknown) {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    return input

  const vars = input as Record<string, unknown>
  if (vars.JACK_MANAGEMENT_KEY === undefined)
    return vars

  return { ...vars, MANAGEMENT_KEY: vars.JACK_MANAGEMENT_KEY }
}

export const Envs = z.preprocess(preferPrefixedManagementKey, z.object({
  PORT: z.coerce.number().int().default(5225),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  ENVIRONMENT: z.enum(['development', 'production']).default('development'),
  APP_CONFIG_PATH: z.string().default('/config/config.jsonc'),
  // Default timeout (ms) for every outgoing HTTP request to a connector (*arr or
  // peer). Bounds a hung host so it can't stall a search indefinitely.
  HTTP_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
  // OpenTelemetry tracing. There's no on/off flag: tracing is enabled as soon as
  // an OTLP/HTTP endpoint is configured (see `isOtelEnabled`). Either the generic
  // endpoint or the traces-specific one works — both are the standard OTEL vars
  // the exporter itself reads.
  OTEL_EXPORTER_OTLP_ENDPOINT: z.url().optional(),
  OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: z.url().optional(),
  OTEL_SERVICE_NAME: z.string().default('jack-backend'),
  NODE_ENV: z.string().optional(),
  ENABLE_LOGS: z.stringbool().optional().default(true),
  // Persist logs to a rotating NDJSON file the management API serves to the UI.
  LOG_TO_FILE: z.stringbool().optional().default(true),
  // Directory for the rotating log files. Defaults to a `logs/` dir next to the
  // config file (the same persistent volume as the sqlite DB).
  LOG_DIR: z.string().optional(),
  // Rotate the active log file once it reaches this many bytes (default 10 MiB).
  LOG_MAX_FILE_BYTES: z.coerce.number().int().positive().default(10_485_760),
  // Keep this many rotated files (plus the active one); older ones are pruned.
  LOG_MAX_FILES: z.coerce.number().int().min(0).default(5),
  // Management API credential. The preprocess above maps JACK_MANAGEMENT_KEY here
  // when present; MANAGEMENT_KEY remains supported for backwards compatibility.
  MANAGEMENT_KEY: z.string().min(1).optional(),
  // Port for the management API listener (separate from the public PORT so the
  // peer-facing port never exposes management at all). Only used when a management
  // key is set.
  MANAGEMENT_PORT: z.coerce.number().int().default(5226),
}).transform(vars => ({
  ...vars,
  ENABLE_LOGS: vars.NODE_ENV !== 'test' && vars.ENABLE_LOGS,
  // Never write log files during tests (they construct their own temp sinks).
  LOG_TO_FILE: vars.NODE_ENV !== 'test' && vars.LOG_TO_FILE,
})))

export type Envs = z.infer<typeof Envs>

export function getAppEnvs() {
  return Envs.parse(Bun.env)
}

/**
 * Tracing is on when an OTLP endpoint is configured — no separate enable flag.
 * The exporter accepts the generic endpoint or the traces-specific one, so the
 * presence of either turns tracing on.
 */
export function isOtelEnabled(envs: Envs) {
  return Boolean(envs.OTEL_EXPORTER_OTLP_ENDPOINT || envs.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT)
}
