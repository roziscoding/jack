import type { AppDatabase } from '../../database/connection'
import type { ApiKeyRow, NewApiKeyRow } from '../../database/schema'
import { desc, eq } from 'drizzle-orm'
import { apiKeys } from '../../database/schema'

export interface ApiKeyRecord {
  id: number
  keyHash: string
  name: string | null
  description: string | null
  expiresAt: string | null
  createdAt: string
  updatedAt: string
}

export interface CreateApiKeyInput {
  keyHash: string
  name?: string | null
  description?: string | null
  expiresAt?: string | null
}

export interface UpdateApiKeyInput {
  name?: string | null
  description?: string | null
  expiresAt?: string | null
}

function nowIso() {
  return new Date().toISOString()
}

function toRecord(row: ApiKeyRow): ApiKeyRecord {
  return {
    id: row.id,
    keyHash: row.keyHash,
    name: row.name,
    description: row.description,
    expiresAt: row.expiresAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

export class ApiKeysRepository {
  constructor(private readonly db: AppDatabase) {}

  create(input: CreateApiKeyInput): ApiKeyRecord {
    const timestamp = nowIso()
    const values: NewApiKeyRow = {
      keyHash: input.keyHash,
      name: input.name ?? null,
      description: input.description ?? null,
      expiresAt: input.expiresAt ?? null,
      createdAt: timestamp,
      updatedAt: timestamp,
    }

    const row = this.db.insert(apiKeys).values(values).returning().get()
    return toRecord(row)
  }

  findByHash(keyHash: string): ApiKeyRecord | null {
    const row = this.db.select().from(apiKeys).where(eq(apiKeys.keyHash, keyHash)).get()
    return row ? toRecord(row) : null
  }

  get(id: number): ApiKeyRecord | null {
    const row = this.db.select().from(apiKeys).where(eq(apiKeys.id, id)).get()
    return row ? toRecord(row) : null
  }

  list(): ApiKeyRecord[] {
    return this.db.select().from(apiKeys).orderBy(desc(apiKeys.createdAt)).all().map(toRecord)
  }

  update(id: number, input: UpdateApiKeyInput): ApiKeyRecord | null {
    const row = this.db.update(apiKeys)
      .set({
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
        updatedAt: nowIso(),
      })
      .where(eq(apiKeys.id, id))
      .returning()
      .get()

    return row ? toRecord(row) : null
  }

  delete(id: number): boolean {
    const existing = this.get(id)
    if (!existing) {
      return false
    }
    this.db.delete(apiKeys).where(eq(apiKeys.id, id)).run()
    return true
  }
}
