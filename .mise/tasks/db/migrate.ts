#!/usr/bin/env bun
//MISE description="Apply pending migrations to the database next to APP_CONFIG_PATH, the same way the backend does on boot"

// Same cwd and APP_CONFIG_PATH (from mise.toml) as `mise run dev`, so this
// migrates the database the dev backend opens.
import { dirname, resolve } from 'node:path'
import process from 'node:process'
import { openDatabase } from '@jack/backend/src/database/connection'
import { getAppEnvs } from '@jack/backend/src/lib/envs'

process.chdir(dirname(require.resolve('@jack/backend/package.json')))

const { APP_CONFIG_PATH } = getAppEnvs()
const handle = await openDatabase({ appConfigPath: APP_CONFIG_PATH })
console.log(`Migrated ${resolve(handle.path)}`)
handle.close()
