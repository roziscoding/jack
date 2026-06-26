import type { ManagedApiKeys } from '../modules/managed-keys/managed-keys.service'
import type { ArrServerConnector } from './servers/arr/base'

export interface ManagedRegistrationMeta {
  downloadClientId?: number
  categories?: number[]
}

export interface ManagedRegistrationDeps {
  managedKeys: ManagedApiKeys
  baseUrl: string
  downloads: boolean
  category: string
  onSuccess: (kind: 'download client' | 'indexer', name: string, meta: ManagedRegistrationMeta) => void
  onFailure: (kind: 'download client' | 'indexer', name: string, err: unknown) => void
}

/**
 * Provision a fresh managed key for one destination and register Jack as its qBittorrent
 * download client + Torznab indexer using that key. Rollback-safe:
 * - every attempted registration succeeded → commit (drop the previous key);
 * - some but not all succeeded → keep both old + new (each consumer holds a valid key);
 * - nothing was delivered to *arr → discard the new key (it would only linger as a
 *   valid-but-unused credential; the old keys stay valid for retry next boot).
 */
export async function registerManagedForDestination(
  dest: ArrServerConnector,
  deps: ManagedRegistrationDeps,
): Promise<void> {
  const { managedKeys, baseUrl, downloads, category } = deps
  const { id: keyId, key } = managedKeys.provision(dest.id)

  let downloadClientId: number | undefined
  let downloadDelivered = false
  if (downloads) {
    try {
      downloadClientId = await dest.registerDownloadClient({
        name: 'Jack',
        baseUrl,
        username: dest.name,
        password: key,
        category,
      })
      downloadDelivered = true
      deps.onSuccess('download client', dest.name, { downloadClientId })
    }
    catch (err) {
      deps.onFailure('download client', dest.name, err)
    }
  }

  let indexerDelivered = false
  try {
    await dest.registerIndexer({
      name: 'Jack',
      baseUrl: `${baseUrl}/torznab`,
      apiKey: key,
      priority: dest.autoRegister.priority,
      categories: dest.categories,
      downloadClientId,
    })
    indexerDelivered = true
    deps.onSuccess('indexer', dest.name, { downloadClientId, categories: dest.categories })
  }
  catch (err) {
    deps.onFailure('indexer', dest.name, err)
  }

  // "Attempted" download = only when downloads is enabled. The indexer is always attempted.
  const allAttemptedOk = (downloads ? downloadDelivered : true) && indexerDelivered
  const anyDelivered = downloadDelivered || indexerDelivered

  if (allAttemptedOk)
    managedKeys.commit(dest.id, keyId)
  else if (!anyDelivered)
    managedKeys.discard(keyId)
  // else: partial success — keep both old + new so each consumer keeps a valid key.
}
