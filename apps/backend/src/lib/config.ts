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
 * from the environment or filesystem
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

// Raw (ref-preserving) secret: the union BEFORE ConfigSecret resolves it. Used only
// for persistence so the versioned file keeps {env}/{file} refs. Declared up here so
// both RawPeerConfig (below) and RawServerConfig (Phase 5) can reference it.
export const RawConfigSecret = z.union([
  z.string(),
  z.object({ env: z.string().min(1) }),
  z.object({ file: z.string().min(1) }),
])

export const ServerType = z.enum(['radarr', 'sonarr'])

export type ServerType = z.infer<typeof ServerType>

export type ConnectorType = ServerType | 'jack'

export const ConnectorHeadersConfig = z.record(z.string(), ConfigSecret()).default({})

export type ConnectorHeadersConfig = z.infer<typeof ConnectorHeadersConfig>

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
  source: z.boolean().default(true),
  destination: z.boolean().default(true),
  autoregister: AutoRegisterConfig.prefault({}),
})

export type ServerConfig = z.infer<typeof ServerConfig>

export const PeerConfig = z.object({
  name: z.string(),
  url: z.url(),
  apiKey: ConfigSecret(),
  headers: ConnectorHeadersConfig,
})

export type PeerConfig = z.infer<typeof PeerConfig>

// Raw peer for persistence: declares exactly the fields we store, so unknown keys
// from a management-client body are stripped before they reach the file.
export const RawPeerConfig = z.object({
  name: z.string(),
  url: z.url(),
  apiKey: RawConfigSecret,
  headers: z.record(z.string(), RawConfigSecret).optional(),
})

export type RawPeerConfig = z.infer<typeof RawPeerConfig>

export const JackConfig = z.object({
  baseUrl: z.url(),
  apiKey: ConfigSecret(),
})

export type JackConfig = z.infer<typeof JackConfig>

export const DownloadsConfig = z.object({
  completedPath: z.string().min(1),
  maxConcurrentDownloads: z.number().int().min(1).default(3),
  maxDownloadAttempts: z.number().int().min(1).default(13),
  retryBaseDelayMs: z.number().int().min(0).default(1000),
  retryMaxDelayMs: z.number().int().min(0).default(1_800_000),
  idleTimeoutMs: z.number().int().min(1000).default(60_000),
})

export type DownloadsConfig = z.infer<typeof DownloadsConfig>

export const AppConfig = z.object({
  version: z.number(),
  jack: JackConfig.optional(),
  downloads: DownloadsConfig.optional(),
  servers: z.array(ServerConfig).default([]),
  peers: z.array(PeerConfig).default([]),
})

export type AppConfig = z.infer<typeof AppConfig>

export const MIGRATIONS = [
  <T extends object>(obj: T): T & { version: number } => ({ ...obj, version: 1 }),
]
const LATEST_MIGRATION = MIGRATIONS.length

export function migrateConfig(rawConfigObject: unknown) {
  const configObject = z
    .looseObject({ version: z.number().max(LATEST_MIGRATION).min(0).default(0) })
    .catch({ version: 0 })
    .parse(rawConfigObject)

  const currentVersion = configObject.version
  const migrationsToApply = MIGRATIONS.slice(currentVersion)

  if (migrationsToApply.length === 0) {
    return
  }

  logger.debug(`Migrating config from version ${currentVersion} to version ${MIGRATIONS.length}`)

  return migrationsToApply.reduce((acc, migration, idx) => {
    logger.trace({ input: acc }, `Migrating to version ${idx + 1}`)
    return migration(acc)
  }, configObject)
}

const DEFAULT_APP_CONFIG: z.input<typeof AppConfig> = {
  version: MIGRATIONS.length,
  jack: {
    baseUrl: 'http://jack:5225',
    apiKey: { env: 'JACK_API_KEY' },
  },
  servers: [],
  peers: [],
}

const EMPTY_APP_CONFIG: AppConfig = {
  version: MIGRATIONS.length,
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

  const migratedConfig = migrateConfig(fileContent)

  logger.debug(`Validating app config`)
  return AppConfig.parse(migratedConfig)
}
