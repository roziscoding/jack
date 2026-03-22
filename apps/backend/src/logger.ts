import process from 'node:process'
import { pino } from 'pino'

export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'debug',
  transport: process.env.ENVIRONMENT !== 'production'
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
