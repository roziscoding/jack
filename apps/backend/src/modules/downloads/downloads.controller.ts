import type { DownloadsRepository } from './downloads.repository'
import type { DownloadsService } from './downloads.service'
import type { ImportWatcher } from './import-watcher'
import { ConflictError } from '../../lib/errors/ConflictError'
import { NotFoundError } from '../../lib/errors/NotFoundError'

export class DownloadsManagementController {
  constructor(
    private readonly downloadsRepository?: DownloadsRepository,
    private readonly downloadsService?: DownloadsService,
    private readonly importWatcher?: ImportWatcher,
  ) {}

  private requireDownloadsService(): DownloadsService {
    if (!this.downloadsService)
      throw new ConflictError('Download management is unavailable')
    return this.downloadsService
  }

  async cancel(id: number) {
    return { download: await this.requireDownloadsService().cancel(id) }
  }

  async retry(id: number) {
    const record = this.downloadsRepository?.get(id)
    if (!record)
      throw new NotFoundError(`Download ${id} not found`)
    if (!record.operationFailed)
      throw new ConflictError(`Download ${id} has no failed operation to retry`)

    if (record.lastOperation === 'import') {
      if (!this.importWatcher)
        throw new ConflictError('Import retry is unavailable')
      return { download: await this.importWatcher.retry(id) }
    }

    return { download: this.requireDownloadsService().retry(id) }
  }

  async delete(id: number) {
    await this.requireDownloadsService().delete(id)
    return { ok: true }
  }
}
