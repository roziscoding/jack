import type { DownloadsRepository } from './downloads.repository'

/** Coordinates per-download import/delete work and reserves paths during deletion. */
export class DownloadOperationCoordinator {
  private readonly tails = new Map<number, Promise<void>>()
  private readonly deletingPaths = new Map<string, number>()

  async runExclusive<T>(id: number, operation: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(id) ?? Promise.resolve()
    const gate = Promise.withResolvers<void>()
    const tail = previous.catch(() => {}).then(() => gate.promise)
    this.tails.set(id, tail)
    await previous.catch(() => {})
    try {
      return await operation()
    }
    finally {
      gate.resolve()
      if (this.tails.get(id) === tail)
        this.tails.delete(id)
    }
  }

  async runDelete<T>(id: number, paths: string[], operation: () => Promise<T>): Promise<T> {
    for (const path of paths)
      this.deletingPaths.set(path, (this.deletingPaths.get(path) ?? 0) + 1)
    try {
      return await this.runExclusive(id, operation)
    }
    finally {
      for (const path of paths) {
        const remaining = (this.deletingPaths.get(path) ?? 1) - 1
        if (remaining === 0)
          this.deletingPaths.delete(path)
        else
          this.deletingPaths.set(path, remaining)
      }
    }
  }

  isPathDeleting(path: string): boolean {
    return this.deletingPaths.has(path)
  }
}

const coordinators = new WeakMap<DownloadsRepository, DownloadOperationCoordinator>()

export function coordinatorFor(repository: DownloadsRepository): DownloadOperationCoordinator {
  let coordinator = coordinators.get(repository)
  if (!coordinator) {
    coordinator = new DownloadOperationCoordinator()
    coordinators.set(repository, coordinator)
  }
  return coordinator
}
