import { pino } from 'pino'
import { getAppEnvs } from './lib/envs'

const envs = getAppEnvs()

export const logger = pino({
  level: envs.LOG_LEVEL,
  transport: envs.ENVIRONMENT !== 'production'
    ? {
        target: 'pino-pretty',
        options: {
          colorize: true,
          singleLine: true,
          ignore: 'pid,hostname'
        },
      }
    : undefined,
})
