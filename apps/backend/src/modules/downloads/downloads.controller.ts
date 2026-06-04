import type { DownloadsRepository } from './downloads.repository'

export class DownloadsController {
  constructor(private readonly repository: DownloadsRepository) {}

  listDownloads() {
    return { downloads: this.repository.list() }
  }

  getDownload(id: number) {
    return this.repository.get(id)
  }
}
