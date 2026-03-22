import { z } from 'zod'

export const Envs = z.object({
  PORT: z.coerce.number().int().default(3000),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  ENVIRONMENT: z.enum(['development', 'production']).default('development'),
  APP_CONFIG_PATH: z.string().default('/config/config.jsonc'),
})

export type Envs = z.infer<typeof Envs>

export function getAppEnvs() {
  return Envs.parse(Bun.env)
}
