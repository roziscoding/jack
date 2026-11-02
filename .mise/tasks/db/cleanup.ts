#!/usr/bin/env bun
//MISE description="Delete the database next to APP_CONFIG_PATH and its -wal/-shm files (the ones db:migrate creates)"

// Resolves the path the same way as db:migrate and `mise run dev`.
import { rm } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import process from 'node:process'
import { getDatabasePath } from '@jack/backend/src/database/connection'
import { getAppEnvs } from '@jack/backend/src/lib/envs'

process.chdir(dirname(require.resolve('@jack/backend/package.json')))

const databasePath = resolve(getDatabasePath(getAppEnvs().APP_CONFIG_PATH))

for (const path of [databasePath, `${databasePath}-wal`, `${databasePath}-shm`]) {
  if (await Bun.file(path).exists()) {
    await rm(path)
    console.log(`Deleted ${path}`)
  }
}
