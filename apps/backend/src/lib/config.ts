import type { Envs } from './envs'
import fs from 'node:fs/promises'
import { jsonc } from 'jsonc'
import z from 'zod'
import { logger } from '../logger'

export const DestinationServerType = z.enum(['sonarr', 'radarr'])

export type DestinationServerType = z.infer<typeof DestinationServerType>

export const DestinationServerConfig = z.object({
  name: z.string().optional(),
  url: z.url(),
  apiKey: z.hex().min(32).max(32),
  type: DestinationServerType,
})

export type DestinationServerConfig = z.infer<typeof DestinationServerConfig>

export const SourceServerType = z.enum(['jellyfin'])

export type SourceServerType = z.infer<typeof SourceServerType>

export const SourceServerConfig = z.object({
  name: z.string().optional(),
  url: z.url(),
  apiKey: z.string().min(1),
  type: SourceServerType,
})

export type SourceServerConfig = z.infer<typeof SourceServerConfig>

export const PeerServerConfig = z.object({
  name: z.string().optional(),
  url: z.url(),
  apiKey: z.string().min(1),
})

export type PeerServerConfig = z.infer<typeof PeerServerConfig>

export type ServerType = SourceServerType | DestinationServerType | 'jack'

export const JackConfig = z.object({
  baseUrl: z.url(),
  apiKey: z.string().min(1),
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

const DEFAULT_APP_CONFIG: AppConfig = {
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
    return DEFAULT_APP_CONFIG
  }

  logger.debug(`Loading config file from ${APP_CONFIG_PATH}`)
  const fileTextContent = await Bun.file(APP_CONFIG_PATH).text()

  logger.debug(`Parsing config file content`)
  const fileContent = jsonc.parse(fileTextContent)

  logger.debug(`Validating app config`)
  return AppConfig.parse(fileContent)
}
