import { Database } from 'bun:sqlite'
import { afterEach, describe, expect, test } from 'bun:test'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { runMigrations } from '../database/connection'
import * as schema from '../database/schema'
import { DownloadsRepository } from '../modules/downloads/downloads.repository'

const dbs: Database[] = []
afterEach(() => {
  for (const db of dbs.splice(0)) db.close()
})

function makeRepo() {
  const database = new Database(':memory:')
  dbs.push(database)
  database.exec('pragma foreign_keys = ON')
  const db = drizzle({ client: database, schema })
  runMigrations(db)
  return new DownloadsRepository(db)
}

function seed(repo: DownloadsRepository, peerId: string, filename: string) {
  return repo.create({
    torrentFilename: `${filename}.torrent`,
    peerId,
    peerName: peerId,
    itemId: 'movie:1',
    filename,
    destPath: `/tmp/${filename}`,
    partPath: `/tmp/${filename}.part`,
    releaseSize: 1,
    release: { id: 'r', title: filename, filename, category: 2000, size: 1 } as any,
  })
}

describe('DownloadsRepository.reassignPeerId', () => {
  test('moves only the matching rows', () => {
    const repo = makeRepo()
    const a = seed(repo, 'oldid', 'a')
    const b = seed(repo, 'oldid', 'b')
    const c = seed(repo, 'other', 'c')

    repo.reassignPeerId('oldid', 'newid')

    expect(repo.get(a.id)?.peerId).toBe('newid')
    expect(repo.get(b.id)?.peerId).toBe('newid')
    expect(repo.get(c.id)?.peerId).toBe('other')
  })
})
