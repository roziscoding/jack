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

export type ServerType = SourceServerType | DestinationServerType

export const AppConfig = z.object({
  servers: z.object({
    sources: z.array(SourceServerConfig),
    destinations: z.array(DestinationServerConfig),
  }),
})

export type AppConfig = z.infer<typeof AppConfig>

const DEFAULT_APP_CONFIG: AppConfig = {
  servers: {
    sources: [],
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
