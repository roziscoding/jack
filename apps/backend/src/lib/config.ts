import type { Envs } from './envs'
import { readFileSync } from 'node:fs'
import fs from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import process from 'node:process'
import { jsonc } from 'jsonc'
import z from 'zod'
import { logger } from '../logger'
import { atomicWriteFile } from './atomic-write'

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

// Raw server for persistence: strip unknown keys from a management-client body while
// preserving {env}/{file} secret refs, mirroring RawPeerConfig.
export const RawServerConfig = z.object({
  name: z.string(),
  url: z.url(),
  apiKey: RawConfigSecret,
  headers: z.record(z.string(), RawConfigSecret).optional(),
  type: ServerType,
  source: z.boolean().optional(),
  destination: z.boolean().optional(),
  autoregister: z.object({ enable: z.boolean().optional(), priority: z.number().int().optional() }).optional(),
})

export type RawServerConfig = z.infer<typeof RawServerConfig>

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

const RESERVED_EXTERNAL_HEADERS = new Set([
  'x-api-key',
  'host',
  'content-length',
  'connection',
  'transfer-encoding',
])
const DANGEROUS_EXTERNAL_HEADER_NAMES = new Set(['__proto__', 'prototype', 'constructor'])
const HTTP_HEADER_LINE_BREAK = /[\r\n]/

const ExternalHeaderName = z.string()
  .trim()
  .min(1)
  .regex(/^[!#$%&'*+\-.^`|~\w]+$/, 'Invalid HTTP header name')
  .refine(name => !DANGEROUS_EXTERNAL_HEADER_NAMES.has(name.toLowerCase()), 'Dangerous HTTP header name')
  .refine(name => !RESERVED_EXTERNAL_HEADERS.has(name.toLowerCase()), 'Reserved HTTP header')

const ExternalHeaderValue = z.string()
  .min(1)
  .refine(value => !HTTP_HEADER_LINE_BREAK.test(value), 'HTTP header values cannot contain line breaks')

const ExternalJackUrl = z.url().refine((value) => {
  const url = new URL(value)
  return (url.protocol === 'http:' || url.protocol === 'https:')
    && !url.username
    && !url.password
}, 'External URL must use HTTP or HTTPS and cannot contain userinfo credentials')

// Inspect raw keys before z.record builds its output object. In particular,
// assigning `__proto__` onto a normal object can otherwise mutate its prototype
// instead of surviving as an own key for the key schema to validate.
const ExternalHeadersObject = z.unknown().superRefine((headers, ctx) => {
  if (typeof headers !== 'object' || headers === null || Array.isArray(headers))
    return
  const normalizedNames = new Set<string>()
  for (const name of Object.keys(headers)) {
    const normalizedName = name.toLowerCase()
    if (DANGEROUS_EXTERNAL_HEADER_NAMES.has(normalizedName))
      ctx.addIssue({ code: 'custom', message: 'Dangerous HTTP header name' })
    if (normalizedNames.has(normalizedName))
      ctx.addIssue({ code: 'custom', message: 'Duplicate HTTP header name' })
    normalizedNames.add(normalizedName)
  }
})

const ResolvedExternalHeaders = ExternalHeadersObject.pipe(z.record(ExternalHeaderName, ConfigSecret(ExternalHeaderValue)))
  .refine(headers => Object.keys(headers).length <= 100, 'At most 100 external headers are allowed')

const RawExternalHeaders = ExternalHeadersObject.pipe(z.record(ExternalHeaderName, RawConfigSecret))
  .refine(headers => Object.keys(headers).length <= 100, 'At most 100 external headers are allowed')

export const ExternalJackConfig = z.object({
  instanceName: z.string().trim().min(1).max(100).optional(),
  url: ExternalJackUrl,
  headers: ResolvedExternalHeaders.default({}),
})

export type ExternalJackConfig = z.infer<typeof ExternalJackConfig>

export const RawExternalJackConfig = z.object({
  instanceName: z.string().trim().min(1).max(100).optional(),
  url: ExternalJackUrl,
  headers: RawExternalHeaders.optional(),
})

export type RawExternalJackConfig = z.infer<typeof RawExternalJackConfig>

export const JackConfig = z.object({
  internalUrl: z.url(),
  // The single "Main API key" (deprecated). Optional: a jack block can carry
  // only an internalUrl, in which case the public API authenticates via generated
  // keys (see require-auth.ts), not this key.
  apiKey: ConfigSecret().optional(),
  // Optional TMDB v3 API key for enriching peer catalogs with artwork/metadata.
  tmdbApiKey: ConfigSecret().optional(),
  // How another Jack reaches this instance. Header secrets resolve only when a
  // quick link is generated; raw refs remain intact in the persisted config.
  external: ExternalJackConfig.optional(),
})

export type JackConfig = z.infer<typeof JackConfig>

// Raw jack for persistence: preserve {env}/{file} secret refs and the optional
// apiKey, mirroring RawPeerConfig/RawServerConfig.
export const RawJackConfig = z.object({
  internalUrl: z.url(),
  apiKey: RawConfigSecret.optional(),
  tmdbApiKey: RawConfigSecret.optional(),
  external: RawExternalJackConfig.optional(),
})

export type RawJackConfig = z.infer<typeof RawJackConfig>

export const DownloadsConfig = z.object({
  completedPath: z.string().min(1),
  maxConcurrentDownloads: z.number().int().min(1).default(3),
  maxDownloadAttempts: z.number().int().min(1).default(13),
  retryBaseDelayMs: z.number().int().min(0).default(1000),
  retryMaxDelayMs: z.number().int().min(0).default(1_800_000),
  idleTimeoutMs: z.number().int().min(1000).default(60_000),
  // How often the import watcher polls each destination *arr's history to detect
  // which finished downloads it has imported (flipping them import_queued → imported).
  importPollIntervalMs: z.number().int().min(1000).default(30_000),
  // When a jack_manual import trigger keeps failing (e.g. *arr returns 500 because
  // the movie's library folder is missing), the watcher backs off exponentially
  // between attempts instead of re-triggering every tick, and gives up — marking
  // the row failed — after this many attempts. This stops a broken import from
  // flooding *arr indefinitely.
  maxManualImportAttempts: z.number().int().min(1).default(6),
  manualImportBackoffBaseMs: z.number().int().min(0).default(60_000),
  manualImportBackoffMaxMs: z.number().int().min(0).default(1_800_000),
  // Once *arr has imported a download, jack's copy in completedPath is dead weight:
  // *arr either hardlinked it into the library (so the data lives on through the
  // library's link) or copied it. Enabling this unlinks jack's directory entry —
  // never a recursive delete — right after a row flips to `imported`.
  unlinkImportedFiles: z.boolean().default(false),
})

export type DownloadsConfig = z.infer<typeof DownloadsConfig>

// Raw downloads for persistence: a PATCH body merged onto the stored block, so every
// field is optional and the merged result is validated through DownloadsConfig before
// it reaches the file (see ConfigService.updateDownloads).
//
// `null` on a tuning knob means "drop this key from the file" — the value goes back to
// the schema default above, which is how the UI offers "clear a field to use the
// default". `completedPath` is the one key with no default, so it is not nullable:
// a downloads block without it cannot be validated.
export const RawDownloadsConfig = z.object({
  completedPath: z.string().min(1).optional(),
  maxConcurrentDownloads: z.number().int().min(1).nullish(),
  maxDownloadAttempts: z.number().int().min(1).nullish(),
  retryBaseDelayMs: z.number().int().min(0).nullish(),
  retryMaxDelayMs: z.number().int().min(0).nullish(),
  idleTimeoutMs: z.number().int().min(1000).nullish(),
  importPollIntervalMs: z.number().int().min(1000).nullish(),
  maxManualImportAttempts: z.number().int().min(1).nullish(),
  manualImportBackoffBaseMs: z.number().int().min(0).nullish(),
  manualImportBackoffMaxMs: z.number().int().min(0).nullish(),
  unlinkImportedFiles: z.boolean().nullish(),
})

export type RawDownloadsConfig = z.infer<typeof RawDownloadsConfig>

export const AppConfig = z.object({
  version: z.number(),
  jack: JackConfig,
  downloads: DownloadsConfig.optional(),
  servers: z.array(ServerConfig).default([]),
  peers: z.array(PeerConfig).default([]),
})

export type AppConfig = z.infer<typeof AppConfig>

export const MIGRATIONS = [
  <T extends object>(obj: T): T & { version: number } => ({ ...obj, version: 1 }),
  // v2: rename jack.baseUrl → jack.internalUrl (an external URL will be added later).
  <T extends object>(obj: T): T & { version: number } => {
    const cfg = obj as T & { jack?: Record<string, unknown> }
    if (cfg.jack && 'baseUrl' in cfg.jack) {
      const { baseUrl, ...rest } = cfg.jack
      return { ...obj, jack: { ...rest, internalUrl: baseUrl }, version: 2 } as T & { version: number }
    }
    return { ...obj, version: 2 } as T & { version: number }
  },
]
const LATEST_MIGRATION = MIGRATIONS.length

export function migrateConfig(rawConfigObject: unknown) {
  const configObject = z
    .looseObject({ version: z.number().max(LATEST_MIGRATION).min(0).default(0).catch(0) })
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
    internalUrl: 'http://jack:5225',
  },
  servers: [],
  peers: [],
}

const EMPTY_APP_CONFIG: AppConfig = {
  version: MIGRATIONS.length,
  // jack is required; the resolved fallback carries only an internalUrl (no master key —
  // auto-registration provisions its own managed keys).
  jack: { internalUrl: 'http://jack:5225' },
  servers: [],
  peers: [],
}

async function createDefaultAppConfig(path: string) {
  const configFileExists = await fs.exists(path)
  if (!configFileExists) {
    await fs.writeFile(path, jsonc.stringify(DEFAULT_APP_CONFIG, { space: 2 }))
  }
}

export async function getAppConfig({ APP_CONFIG_PATH }: Pick<Envs, 'APP_CONFIG_PATH'>): Promise<{ appConfig: AppConfig, raw: z.input<typeof AppConfig> }> {
  const configFileExists = await fs.exists(APP_CONFIG_PATH)

  if (!configFileExists) {
    logger.warn(`Config file not found at ${APP_CONFIG_PATH}. Creating default config file...`)
    await createDefaultAppConfig(APP_CONFIG_PATH)

    const defaultConfig = AppConfig.safeParse(DEFAULT_APP_CONFIG)
    if (defaultConfig.success)
      return { appConfig: defaultConfig.data, raw: DEFAULT_APP_CONFIG }

    // The runtime config is empty (the referenced secrets can't be resolved yet),
    // but `raw` must mirror what we just wrote to disk — DEFAULT_APP_CONFIG, jack
    // template included. Seeding ConfigService with EMPTY_APP_CONFIG instead would
    // make the first management mutation persist a config without the jack template,
    // silently clobbering the file that createDefaultAppConfig just created.
    logger.warn('Default config references environment variables that are not set. Starting with an empty config until they are provided.')
    return { appConfig: EMPTY_APP_CONFIG, raw: DEFAULT_APP_CONFIG }
  }

  logger.debug(`Loading config file from ${APP_CONFIG_PATH}`)
  const fileTextContent = await Bun.file(APP_CONFIG_PATH).text()
  const fileContent = jsonc.parse(fileTextContent)

  // `migrateConfig` returns the migrated object, or `undefined` when the file is
  // already current. On a real migration, back up the original bytes (comments
  // intact) then atomically rewrite the file so the upgrade is durable.
  const migrated = migrateConfig(fileContent)
  if (migrated) {
    logger.info(`Config migrated; writing backup to ${APP_CONFIG_PATH}.bak and persisting`)
    await Bun.write(`${APP_CONFIG_PATH}.bak`, fileTextContent)
    await atomicWriteFile(APP_CONFIG_PATH, jsonc.stringify(migrated, { space: 2 }))
  }

  // `migrated ?? fileContent` also fixes the up-to-date-file crash (migrateConfig
  // returns undefined when current; parsing undefined used to throw).
  const raw = (migrated ?? fileContent) as z.input<typeof AppConfig>
  logger.debug(`Validating app config`)
  return { appConfig: AppConfig.parse(raw), raw }
}
