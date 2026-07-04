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

/**
 * The rotating file sink, or undefined when file logging is off (tests) or the log
 * directory can't be opened. Construction happens at import time and this module is
 * imported by the logger itself, so a failure must NOT throw — a non-writable
 * `/config` would otherwise crash the process before it starts, even with the
 * management API disabled. Instead we warn to stderr and disable file logging;
 * console/OTel logging keep working.
 */
function createFileSink(): RotatingFileSink | undefined {
  if (!envs.LOG_TO_FILE)
    return undefined
  try {
    return new RotatingFileSink({ path: logFilePath, maxBytes: envs.LOG_MAX_FILE_BYTES, maxFiles: envs.LOG_MAX_FILES })
  }
  catch (err) {
    // Can't use `logger` here (it imports this module).
    console.error(`[jack] file logging disabled: could not open ${logFilePath}: ${err instanceof Error ? err.message : String(err)}`)
    return undefined
  }
}

export const fileSink = createFileSink()

export const logHub = new LogHub(logFilePath)
