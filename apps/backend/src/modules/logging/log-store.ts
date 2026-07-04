import { dirname, join } from 'node:path'
import { getAppEnvs } from '../../lib/envs'
import { LogHub } from './log-hub'
import { RotatingFileSink } from './rotating-file-sink'

// Singletons shared between the logger (which writes to them via pino multistream)
// and the management logs router (which reads/subscribes). Both import this module,
// so they see the same instances.

const envs = getAppEnvs()

/** Active log file; defaults to a `logs/` dir next to the config file (same persistent volume as the sqlite DB). */
export const logFilePath = join(
  envs.LOG_DIR ?? join(dirname(envs.APP_CONFIG_PATH), 'logs'),
  'jack.ndjson',
)

/** Undefined when file logging is disabled (e.g. under test), so the logger simply omits the sink. */
export const fileSink = envs.LOG_TO_FILE
  ? new RotatingFileSink({ path: logFilePath, maxBytes: envs.LOG_MAX_FILE_BYTES, maxFiles: envs.LOG_MAX_FILES })
  : undefined

export const logHub = new LogHub(logFilePath)
