import { z } from 'zod'

export const Envs = z.object({
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
  // Management API credential. When set, the management surface starts on its OWN
  // port (MANAGEMENT_PORT) and every request must carry `X-Management-Key: <this>`.
  // When unset, the management listener is not started at all.
  MANAGEMENT_KEY: z.string().min(1).optional(),
  // Port for the management API listener (separate from the public PORT so the
  // peer-facing port never exposes management at all). Only used when MANAGEMENT_KEY
  // is set.
  MANAGEMENT_PORT: z.coerce.number().int().default(5226),
}).transform(vars => ({
  ...vars,
  ENABLE_LOGS: vars.NODE_ENV !== 'test' && vars.ENABLE_LOGS,
}))

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
