import type { AppDatabase } from '../../database/connection'
import type { ManagedKeyRow } from '../../database/schema'
import { and, eq, ne, notInArray } from 'drizzle-orm'
import { managedKeys } from '../../database/schema'

export interface CreateManagedKeyInput {
  keyHash: string
  serverId: string
}

function nowIso() {
  return new Date().toISOString()
}

export class ManagedKeysRepository {
  constructor(private readonly db: AppDatabase) {}

  create(input: CreateManagedKeyInput): ManagedKeyRow {
    return this.db.insert(managedKeys).values({
      keyHash: input.keyHash,
      serverId: input.serverId,
      createdAt: nowIso(),
    }).returning().get()
  }

  findByHash(keyHash: string): ManagedKeyRow | null {
    return this.db.select().from(managedKeys).where(eq(managedKeys.keyHash, keyHash)).get() ?? null
  }

  findByServerId(serverId: string): ManagedKeyRow[] {
    return this.db.select().from(managedKeys).where(eq(managedKeys.serverId, serverId)).all()
  }

  delete(id: number): void {
    this.db.delete(managedKeys).where(eq(managedKeys.id, id)).run()
  }

  /** Delete every row for this server except `exceptId` (commit a rotation). */
  deleteByServerId(serverId: string, exceptId: number): void {
    this.db.delete(managedKeys).where(and(eq(managedKeys.serverId, serverId), ne(managedKeys.id, exceptId))).run()
  }

  /**
   * Delete rows whose serverId is not in the active set. Empty set → delete all
   * (drizzle's notInArray(col, []) is a no-op, so handle it explicitly).
   */
  deleteOrphans(activeServerIds: string[]): void {
    if (activeServerIds.length === 0) {
      this.db.delete(managedKeys).run()
      return
    }
    this.db.delete(managedKeys).where(notInArray(managedKeys.serverId, activeServerIds)).run()
  }
}
