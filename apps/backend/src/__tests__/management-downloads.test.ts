import { Database } from 'bun:sqlite'
import { describe, expect, mock, test } from 'bun:test'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { runMigrations } from '../database/connection'
import * as schema from '../database/schema'
import { getManagementApp } from '../management-app'
import { DownloadsRepository } from '../modules/downloads/downloads.repository'

const HEADERS = { 'X-Management-Key': 'secret' }

function setup() {
  const sqlite = new Database(':memory:')
  const db = drizzle({ client: sqlite, schema })
  runMigrations(db)
  const repository = new DownloadsRepository(db)
  const row = repository.create({
    torrentFilename: 'one.torrent',
    peerId: 'peer-1',
    peerName: 'Peer',
    itemId: 'movie:1',
    filename: 'one.mkv',
    destPath: '/tmp/one.mkv',
    partPath: '/tmp/one.mkv.part',
    releaseSize: 10,
    release: { id: 'r', title: 'one', filename: 'one.mkv', category: 2000, size: 10 } as any,
  })
  const cancel = mock(async (id: number) => repository.get(id)!)
  const retryTransfer = mock((id: number) => repository.get(id)!)
  const deleteDownload = mock(async (id: number) => repository.delete(id))
  const retryImport = mock(async (id: number) => repository.get(id)!)
  const downloadsService = { cancel, retry: retryTransfer, delete: deleteDownload } as any
  const app = getManagementApp({
    environment: 'test',
    managementKey: 'secret',
    connectors: { peers: [], servers: [] },
    downloadsRepository: repository,
    downloadsService,
    importWatcher: { retry: retryImport } as any,
  })
  return { app, cancel, retryTransfer, retryImport, deleteDownload, repository, row, sqlite }
}

describe('management download actions', () => {
  test('POST /downloads/:id/cancel targets the numeric record id', async () => {
    const { app, cancel, row, sqlite } = setup()

    const response = await app.request(`/downloads/${row.id}/cancel`, { method: 'POST', headers: HEADERS })

    expect(response.status).toBe(200)
    expect(cancel).toHaveBeenCalledWith(row.id)
    sqlite.close()
  })

  test('rejects a non-numeric download id', async () => {
    const { app, cancel, sqlite } = setup()

    const response = await app.request('/downloads/not-a-number/cancel', { method: 'POST', headers: HEADERS })

    expect(response.status).toBe(400)
    expect(cancel).not.toHaveBeenCalled()
    sqlite.close()
  })

  test('POST /downloads/:id/retry dispatches from the persisted last failed operation', async () => {
    const { app, retryTransfer, retryImport, repository, row, sqlite } = setup()
    repository.markFailed(row.id, 'transfer failed', 'transfer')

    const transferResponse = await app.request(`/downloads/${row.id}/retry`, { method: 'POST', headers: HEADERS })
    expect(transferResponse.status).toBe(200)
    expect(retryTransfer).toHaveBeenCalledWith(row.id)

    repository.markImportQueued(row.id)
    repository.markFailed(row.id, 'import failed', 'import')
    // Retry selection is driven by the persisted failed operation, not the display status.
    sqlite.query('UPDATE downloads SET status = ? WHERE id = ?').run('imported', row.id)
    const importResponse = await app.request(`/downloads/${row.id}/retry`, { method: 'POST', headers: HEADERS })
    expect(importResponse.status).toBe(200)
    expect(retryImport).toHaveBeenCalledWith(row.id)
    sqlite.close()
  })

  test('DELETE /downloads/:id delegates deletion by record id', async () => {
    const { app, deleteDownload, row, sqlite } = setup()

    const response = await app.request(`/downloads/${row.id}`, { method: 'DELETE', headers: HEADERS })

    expect(response.status).toBe(200)
    expect(deleteDownload).toHaveBeenCalledWith(row.id)
    sqlite.close()
  })
})
