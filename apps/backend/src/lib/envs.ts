import { z } from 'zod'

export const Envs = z.object({
  PORT: z.coerce.number().int().default(5225),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  ENVIRONMENT: z.enum(['development', 'production']).default('development'),
  APP_CONFIG_PATH: z.string().default('/config/config.jsonc'),
  // OpenTelemetry tracing. There's no on/off flag: tracing is enabled as soon as
  // an OTLP/HTTP endpoint is configured (see `isOtelEnabled`). Either the generic
  // endpoint or the traces-specific one works — both are the standard OTEL vars
  // the exporter itself reads.
  OTEL_EXPORTER_OTLP_ENDPOINT: z.url().optional(),
  OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: z.url().optional(),
  OTEL_SERVICE_NAME: z.string().default('jack-backend'),
})

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
