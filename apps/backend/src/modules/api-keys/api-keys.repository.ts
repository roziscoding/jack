import type { AppDatabase } from '../../database/connection'
import type { ApiKeyRow, NewApiKeyRow } from '../../database/schema'
import { desc, eq } from 'drizzle-orm'
import { apiKeys } from '../../database/schema'

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

export class ApiKeysRepository {
  constructor(private readonly db: AppDatabase) {}

  create(input: CreateApiKeyInput): ApiKeyRow {
    const timestamp = nowIso()
    const values: NewApiKeyRow = {
      keyHash: input.keyHash,
      name: input.name ?? null,
      description: input.description ?? null,
      expiresAt: input.expiresAt ?? null,
      createdAt: timestamp,
      updatedAt: timestamp,
    }

    return this.db.insert(apiKeys).values(values).returning().get()
  }

  findByHash(keyHash: string): ApiKeyRow | null {
    return this.db.select().from(apiKeys).where(eq(apiKeys.keyHash, keyHash)).get() ?? null
  }

  get(id: number): ApiKeyRow | null {
    return this.db.select().from(apiKeys).where(eq(apiKeys.id, id)).get() ?? null
  }

  list(): ApiKeyRow[] {
    return this.db.select().from(apiKeys).orderBy(desc(apiKeys.createdAt)).all()
  }

  update(id: number, input: UpdateApiKeyInput): ApiKeyRow | null {
    return this.db.update(apiKeys)
      .set({
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
        updatedAt: nowIso(),
      })
      .where(eq(apiKeys.id, id))
      .returning()
      .get() ?? null
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
