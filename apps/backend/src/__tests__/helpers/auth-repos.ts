import type { AppDatabase } from '../../database/connection'
import { Database } from 'bun:sqlite'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { runMigrations } from '../../database/connection'
import * as schema from '../../database/schema'
import { ApiKeysRepository } from '../../modules/api-keys/api-keys.repository'
import { ManagedKeysRepository } from '../../modules/managed-keys/managed-keys.repository'

export interface AuthRepos {
  apiKeysRepository: ApiKeysRepository
  managedKeysRepository: ManagedKeysRepository
}

// getApp now requires both auth repositories (the peer and *arr scopes each need
// one). Most tests authenticate with the master key and don't care about the tables,
// so this spins up a throwaway in-memory pair to satisfy the wiring in one line:
//   getApp(envs, config, conns, { ...makeAuthRepos(), downloadsRepository })
// Pass an existing db to seed real keys and have them visible to the app under test.
export function makeAuthRepos(db?: AppDatabase): AuthRepos {
  const database = db ?? (() => {
    const d = drizzle({ client: new Database(':memory:'), schema })
    runMigrations(d)
    return d
  })()

  return {
    apiKeysRepository: new ApiKeysRepository(database),
    managedKeysRepository: new ManagedKeysRepository(database),
  }
}
