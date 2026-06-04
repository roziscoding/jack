import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite'
import { mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { Database } from 'bun:sqlite'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { migrate } from 'drizzle-orm/bun-sqlite/migrator'
import * as schema from './schema'

export type AppDatabase = BunSQLiteDatabase<typeof schema>

export interface DatabaseHandle {
  db: AppDatabase
  sqlite: Database
  path: string
  close: () => void
}

// Migrations live at apps/backend/drizzle. import.meta.dir is
// apps/backend/src/database, so go up two levels. Resolving relative to this
// module (not cwd) keeps it correct under `bun src/index.ts` and bun:test.
export const MIGRATIONS_FOLDER = join(import.meta.dir, '../../drizzle')

export function getDatabasePath(appConfigPath: string) {
  return join(dirname(appConfigPath), 'database.sqlite')
}

// Applies all pending Drizzle migrations. Idempotent: drizzle tracks applied
// migrations in __drizzle_migrations, so this is safe to run on every boot and
// in every test against a fresh in-memory DB.
export function runMigrations(db: AppDatabase) {
  migrate(db, { migrationsFolder: MIGRATIONS_FOLDER })
}

export async function openDatabase({ appConfigPath }: { appConfigPath: string }): Promise<DatabaseHandle> {
  const path = getDatabasePath(appConfigPath)
  await mkdir(dirname(path), { recursive: true })

  const sqlite = new Database(path)
  sqlite.exec('pragma journal_mode = WAL')
  sqlite.exec('pragma foreign_keys = ON')

  const db = drizzle({ client: sqlite, schema })
  runMigrations(db)

  return {
    db,
    sqlite,
    path,
    close: () => sqlite.close(),
  }
}
