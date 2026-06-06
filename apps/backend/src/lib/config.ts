import type { Envs } from './envs'
import { readFileSync } from 'node:fs'
import fs from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import process from 'node:process'
import { jsonc } from 'jsonc'
import z from 'zod'
import { logger } from '../logger'

const TRAILING_LINE_ENDINGS = /[\r\n]+$/

/**
 * A secret value (API key, token, ...) that can be supplied in three ways:
 *
 * - as a plain string: `"my-secret"`
 * - as a reference to an environment variable: `{ "env": "MY_SECRET" }`
 * - as a reference to an absolute file path: `{ "file": "/run/secrets/my-secret" }`
 *
 * Whatever the input shape, the parsed value is always the resolved string, so
 * the rest of the codebase keeps reading `config.*.apiKey` as a plain string and
 * existing string-based configs keep working unchanged.
 *
 * @param value - schema used to validate the resolved string (defaults to a
 * non-empty string). It is applied both to literal strings and to values loaded
 * from the environment or filesystem.
 */
export function ConfigSecret(value: z.ZodType<string, string> = z.string().min(1)) {
  return z
    .union([
      z.string(),
      z.object({ env: z.string().min(1) }),
      z.object({ file: z.string().min(1) }),
    ])
    .transform((input, ctx) => {
      if (typeof input === 'string')
        return input

      if ('env' in input) {
        const resolved = process.env[input.env]

        if (!resolved) {
          ctx.addIssue({
            code: 'custom',
            message: `Environment variable "${input.env}" is not set`,
            fatal: true,
          })
          return z.NEVER
        }

        return resolved
      }

      if (!isAbsolute(input.file)) {
        ctx.addIssue({
          code: 'custom',
          message: `Secret file path "${input.file}" must be absolute`,
          fatal: true,
        })
        return z.NEVER
      }

      try {
        return readFileSync(input.file, 'utf8').replace(TRAILING_LINE_ENDINGS, '')
      }
      catch {
        ctx.addIssue({
          code: 'custom',
          message: `Secret file "${input.file}" could not be read`,
          fatal: true,
        })
        return z.NEVER
      }
    })
    .pipe(value)
}

// A jack-managed server is always a Radarr or Sonarr instance: it can act as a
// source (its library is shared with peers), a destination (jack registers
// itself there and triggers imports), or both.
export const ServerType = z.enum(['radarr', 'sonarr'])

export type ServerType = z.infer<typeof ServerType>

// The connector base also models peers (other jacks), which are sources only.
export type ConnectorType = ServerType | 'jack'

export const ConnectorHeadersConfig = z.record(z.string(), ConfigSecret()).default({})

export type ConnectorHeadersConfig = z.infer<typeof ConnectorHeadersConfig>

// Auto-registration of jack as a Torznab indexer + Torrent Blackhole download
// client inside the *arr. `priority` is the indexer/client priority used there.
export const AutoRegisterConfig = z.object({
  enable: z.boolean().default(true),
  priority: z.number().int().min(1).default(1),
})

export type AutoRegisterConfig = z.infer<typeof AutoRegisterConfig>

export const ServerConfig = z.object({
  name: z.string(),
  url: z.url(),
  apiKey: ConfigSecret(z.hex().min(32).max(32)),
  headers: ConnectorHeadersConfig,
  type: ServerType,
  // Expose this server's library to peers (read by /peer/search).
  source: z.boolean().default(true),
  // Register jack into this server and trigger imports there (written to).
  destination: z.boolean().default(true),
  autoregister: AutoRegisterConfig.prefault({}),
})

export type ServerConfig = z.infer<typeof ServerConfig>

// A peer is another jack instance we fan out to over the /peer API. Sources
// only — the source/destination/autoregister flags don't apply.
export const PeerConfig = z.object({
  name: z.string(),
  url: z.url(),
  apiKey: ConfigSecret(),
  headers: ConnectorHeadersConfig,
})

export type PeerConfig = z.infer<typeof PeerConfig>

export const JackConfig = z.object({
  baseUrl: z.url(),
  apiKey: ConfigSecret(),
})

export type JackConfig = z.infer<typeof JackConfig>

export const DownloadsConfig = z.object({
  completedPath: z.string().min(1),
  // Max peer file downloads running at once (an async semaphore guards the
  // expensive download step). Defaults keep existing configs working.
  maxConcurrentDownloads: z.number().int().min(1).default(3),
  // Bounded retries for transient failures, with exponential backoff + jitter.
  maxDownloadAttempts: z.number().int().min(1).default(5),
  retryBaseDelayMs: z.number().int().min(0).default(1000),
  retryMaxDelayMs: z.number().int().min(0).default(60_000),
})

export type DownloadsConfig = z.infer<typeof DownloadsConfig>

export const AppConfig = z.object({
  jack: JackConfig.optional(),
  downloads: DownloadsConfig.optional(),
  servers: z.array(ServerConfig).default([]),
  peers: z.array(PeerConfig).default([]),
})

export type AppConfig = z.infer<typeof AppConfig>

// Template written to disk to bootstrap a fresh install. API keys default to the
// `{ env: "..." }` form so secrets can be supplied via environment variables
// instead of being hardcoded in the file. Typed as the schema *input* so the
// env-reference shape is allowed here.
const DEFAULT_APP_CONFIG: z.input<typeof AppConfig> = {
  jack: {
    baseUrl: 'http://jack:5225',
    apiKey: { env: 'JACK_API_KEY' },
  },
  servers: [],
  peers: [],
}

// Fallback returned on first boot when the default's env references aren't set
// yet, so the app keeps starting instead of crashing on a fresh install.
const EMPTY_APP_CONFIG: AppConfig = {
  servers: [],
  peers: [],
}

async function createDefaultAppConfig(path: string) {
  const configFileExists = await fs.exists(path)
  if (!configFileExists) {
    await fs.writeFile(path, jsonc.stringify(DEFAULT_APP_CONFIG, { space: 2 }))
  }
}

export async function getAppConfig({ APP_CONFIG_PATH }: Pick<Envs, 'APP_CONFIG_PATH'>) {
  const configFileExists = await fs.exists(APP_CONFIG_PATH)

  if (!configFileExists) {
    logger.warn(`Config file not found at ${APP_CONFIG_PATH}. Creating default config file...`)
    await createDefaultAppConfig(APP_CONFIG_PATH)

    const defaultConfig = AppConfig.safeParse(DEFAULT_APP_CONFIG)
    if (defaultConfig.success)
      return defaultConfig.data

    logger.warn('Default config references environment variables that are not set. Starting with an empty config until they are provided.')
    return EMPTY_APP_CONFIG
  }

  logger.debug(`Loading config file from ${APP_CONFIG_PATH}`)
  const fileTextContent = await Bun.file(APP_CONFIG_PATH).text()

  logger.debug(`Parsing config file content`)
  const fileContent = jsonc.parse(fileTextContent)

  logger.debug(`Validating app config`)
  return AppConfig.parse(fileContent)
}
