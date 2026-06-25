import type { ManagedKeysRepository } from './managed-keys.repository'
import { generateManagedKey, hashKey } from '../../lib/crypto'

/**
 * Boot-time provisioning of per-destination managed keys. Only the hash is stored,
 * so each boot mints a fresh plaintext and pushes it to *arr; the old row is dropped
 * only once the new one is confirmed registered (commit).
 */
export class ManagedApiKeys {
  constructor(private readonly repository: ManagedKeysRepository) {}

  /** Mint a fresh managed key for a destination; persist its hash; return plaintext + row id. */
  provision(serverId: string): { id: number, key: string } {
    const key = generateManagedKey()
    const row = this.repository.create({ keyHash: hashKey(key), serverId })
    return { id: row.id, key }
  }

  /** Keep only the just-registered row for this server (drop the previous key). */
  commit(serverId: string, keepId: number): void {
    this.repository.deleteByServerId(serverId, keepId)
  }

  /**
   * Drop a freshly-provisioned key that was never delivered to *arr (so it can't
   * linger as a valid-but-unused credential).
   */
  discard(id: number): void {
    this.repository.delete(id)
  }

  /** Remove managed rows for servers no longer registrable so their keys can't authenticate. */
  prune(activeServerIds: string[]): void {
    this.repository.deleteOrphans(activeServerIds)
  }
}
