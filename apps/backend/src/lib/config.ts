import type { Envs } from './envs'
import fs from 'node:fs/promises'
import { jsonc } from 'jsonc'
import z from 'zod'
import { logger } from '../logger'

/**
 * A secret value (API key, token, ...) that can be supplied in two ways:
 *
 * - as a plain string: `"my-secret"`
 * - as a reference to an environment variable: `{ "env": "MY_SECRET" }`
 *
 * Whatever the input shape, the parsed value is always the resolved string, so
 * the rest of the codebase keeps reading `config.*.apiKey` as a plain string and
 * existing string-based configs keep working unchanged.
 *
 * @param value - schema used to validate the resolved string (defaults to a
 * non-empty string). It is applied both to literal strings and to values loaded
 * from the environment.
 */
export function ConfigSecret(value: z.ZodType<string, string> = z.string().min(1)) {
  return z
    .union([z.string(), z.object({ env: z.string().min(1) })])
    .transform((input, ctx) => {
      if (typeof input === 'string') return input

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
    })
    .pipe(value)
}

export const DestinationServerType = z.enum(['sonarr', 'radarr'])

export type DestinationServerType = z.infer<typeof DestinationServerType>

export const DestinationServerConfig = z.object({
  name: z.string().optional(),
  url: z.url(),
  apiKey: ConfigSecret(z.hex().min(32).max(32)),
  type: DestinationServerType,
})

export type DestinationServerConfig = z.infer<typeof DestinationServerConfig>

export const SourceServerType = z.enum(['jellyfin'])

export type SourceServerType = z.infer<typeof SourceServerType>

export const SourceServerConfig = z.object({
  name: z.string().optional(),
  url: z.url(),
  apiKey: ConfigSecret(),
  type: SourceServerType,
})

export type SourceServerConfig = z.infer<typeof SourceServerConfig>

export const PeerServerConfig = z.object({
  name: z.string().optional(),
  url: z.url(),
  apiKey: ConfigSecret(),
})

export type PeerServerConfig = z.infer<typeof PeerServerConfig>

export type ServerType = SourceServerType | DestinationServerType | 'jack'

export const JackConfig = z.object({
  baseUrl: z.url(),
  apiKey: ConfigSecret(),
})

export type JackConfig = z.infer<typeof JackConfig>

export const IndexerConfig = z.object({
  priority: z.number().int().min(1).default(1),
  autoRegister: z.boolean().default(true),
})

export type IndexerConfig = z.infer<typeof IndexerConfig>

export const DownloadsConfig = z.object({
  watchPath: z.string().min(1),
  completedPath: z.string().min(1),
})

export type DownloadsConfig = z.infer<typeof DownloadsConfig>

export const AppConfig = z.object({
  jack: JackConfig.optional(),
  indexer: IndexerConfig.optional(),
  downloads: DownloadsConfig.optional(),
  servers: z.object({
    sources: z.array(SourceServerConfig),
    peers: z.array(PeerServerConfig).default([]),
    destinations: z.array(DestinationServerConfig),
  }),
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
  servers: {
    sources: [],
    peers: [],
    destinations: [],
  },
}

// Fallback returned on first boot when the default's env references aren't set
// yet, so the app keeps starting instead of crashing on a fresh install.
const EMPTY_APP_CONFIG: AppConfig = {
  servers: {
    sources: [],
    peers: [],
    destinations: [],
  },
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
    if (defaultConfig.success) return defaultConfig.data

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
