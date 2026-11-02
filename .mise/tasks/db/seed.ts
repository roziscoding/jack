#!/usr/bin/env bun
//MISE description="Reset the downloads and peer catalog cache of the dev database and fill them with samples: downloads in every status and error code, and a cached catalog for each configured peer"
//MISE depends=["db:migrate"]

// Same cwd and APP_CONFIG_PATH (from mise.toml) as `mise run dev`, so this
// seeds the database the dev backend opens. Migrations run on open.
//
// drizzle-seed generates the rows per status group. A second pass then makes
// each row coherent: paths from the filename, progress from the status, and an
// error message that matches the error code.
import type { DownloadStatus } from '@jack/backend/src/database/schema'
import type { FileSystemErrorDetails } from '@jack/backend/src/lib/errors/FileSystemError'
import type { FsStage } from '@jack/backend/src/lib/fs-errors'
import type { PeerCatalogTitle } from '@jack/backend/src/lib/peer-catalog'
import type { DownloadErrorCode } from '@jack/backend/src/modules/downloads/download-error-codes'
import { dirname, resolve } from 'node:path'
import process from 'node:process'
import { openDatabase } from '@jack/backend/src/database/connection'
import { downloads, peerCatalogTitles } from '@jack/backend/src/database/schema'
import { getAppConfig } from '@jack/backend/src/lib/config'
import { FILE_SYSTEM_ERROR_CODES } from '@jack/backend/src/lib/errors/FileSystemError'
import { fileSystemError } from '@jack/backend/src/lib/fs-errors'
import { getAppEnvs } from '@jack/backend/src/lib/envs'
import { generateId } from '@jack/backend/src/lib/servers/base'
import { CatalogCacheRepository } from '@jack/backend/src/modules/catalog/catalog-cache.repository'
import { indexPeerTitles } from '@jack/backend/src/modules/catalog/catalog.lib'
import { DOWNLOAD_ERROR_CODES } from '@jack/backend/src/modules/downloads/download-error-codes'
import { eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { reset, seed } from 'drizzle-seed'

process.chdir(dirname(require.resolve('@jack/backend/package.json')))

const MiB = 1024 * 1024
const GiB = 1024 * MiB
const COMPLETED_PATH = '/data/torrents/completed'
const PEERS = ['Alice', 'Bob', 'Carol']
// Open movies, so the sample data never names a real release.
const TITLES = ['Big.Buck.Bunny', 'Sintel', 'Tears.of.Steel', 'Elephants.Dream', 'Cosmos.Laundromat', 'Spring', 'Agent.327', 'Caminandes']
const QUALITIES = ['1080p.BluRay.x264', '2160p.WEB-DL.HEVC', '720p.WEBRip.x264']
const FILENAMES = TITLES.flatMap(title => QUALITIES.map(quality => `${title}.2024.${quality}.mkv`))

// Open titles for the peer catalog cache. The ones without an id exercise the
// name-keyed path and show as "no metadata" in the UI.
// No artwork: the seed doesn't invent CDN URLs, so posters come from TMDB when
// a key is configured.
const CATALOG_TITLES: Array<Pick<PeerCatalogTitle, 'mediaType' | 'tmdbId' | 'title' | 'genres'> & { episodes?: number }> = [
  { mediaType: 'movie', tmdbId: 10378, title: 'Big Buck Bunny', genres: ['Animation', 'Comedy'] },
  { mediaType: 'movie', tmdbId: 45745, title: 'Sintel', genres: ['Animation', 'Fantasy'] },
  { mediaType: 'movie', tmdbId: 9761, title: 'Elephants Dream', genres: ['Animation', 'Science Fiction'] },
  { mediaType: 'movie', tmdbId: 133701, title: 'Tears of Steel', genres: ['Science Fiction', 'Action'] },
  { mediaType: 'movie', tmdbId: 358332, title: 'Cosmos Laundromat', genres: ['Animation', 'Drama'] },
  { mediaType: 'movie', title: 'Spring', genres: ['Animation', 'Fantasy'] },
  { mediaType: 'movie', title: 'Agent 327: Operation Barbershop', genres: ['Animation', 'Action', 'Comedy'] },
  { mediaType: 'tv', title: 'Caminandes', episodes: 3, genres: ['Animation', 'Comedy'] },
]
const RESOLUTION_SETS = [[2160, 1080], [1080], [720], [1080, 720]]

// Each peer carries most titles, in a mix of resolutions, so titles overlap
// across peers the way they do in a real catalog.
function sampleCatalog(peerIndex: number): PeerCatalogTitle[] {
  return CATALOG_TITLES
    .filter((_, i) => (i + peerIndex) % 3 !== 0)
    .map(({ episodes = 1, ...title }, i) => {
      const resolutions = RESOLUTION_SETS[(i + peerIndex) % RESOLUTION_SETS.length]!
      const releaseCount = episodes * resolutions.length
      return { ...title, releaseCount, totalSize: releaseCount * (2 * GiB + i * 300 * MiB), resolutions }
    })
}

const GROUPS: Array<{ status: DownloadStatus, count: number }> = [
  { status: 'downloading', count: 5 },
  { status: 'import_queued', count: 3 },
  { status: 'imported', count: 8 },
  { status: 'failed', count: DOWNLOAD_ERROR_CODES.length },
]

const MESSAGES: Partial<Record<DownloadErrorCode, string>> = {
  IDLE_TIMEOUT: 'Peer download stalled: no data received for 60000ms',
  INCOMPLETE_DOWNLOAD: 'Incomplete file download: got 1073741824 bytes, expected 2147483648',
  UNKNOWN_SIZE: 'Cannot verify download for item alice:movie:7: no Content-Length/Content-Range and no release size',
  PEER_HTTP_ERROR: 'Failed to download file from peer: Not Found',
  PEER_UNREACHABLE: 'Unable to connect. Is the computer able to access the url?',
  PEER_NOT_FOUND: 'Peer dave not found',
  CANCELLED: 'Download cancelled by user',
  SUPERSEDED: 'superseded by another resumable download for the same destination',
  STALE_AFTER_RESTART: 'stale download after Jack restart; found .part file with 524288000 bytes',
  IMPORT_REJECTED: 'No files found are eligible for import',
  IMPORT_TRIGGER_FAILED: 'manual import failed after 6 attempts: Radarr returned 503 Service Unavailable',
  UNKNOWN_ERROR: 'Peer returned a file response without a body',
}

const CHUNK = 'writing a 65536-byte chunk to the .part at byte 1048576000'
const CHECK = 'checking the .part is still on disk after 1073741824 bytes were written'
const MOVE = 'moving the completed .part into place'

const FS_SAMPLES: Record<typeof FILE_SYSTEM_ERROR_CODES[number], { errno: string, stage: FsStage, operation: string, explanation?: string }> = {
  PART_DIR_MISSING: { errno: 'ENOENT', stage: 'create_part', operation: 'creating the .part file' },
  PART_CREATE_DENIED: { errno: 'EACCES', stage: 'create_part', operation: 'creating the .part file' },
  PART_RESUME_DENIED: { errno: 'EACCES', stage: 'resume_part', operation: 'opening the .part to resume at byte 524288000' },
  PART_WRITE_DENIED: { errno: 'EACCES', stage: 'write_part', operation: CHUNK },
  PART_DELETED: { errno: 'ENOENT', stage: 'write_part', operation: CHECK, explanation: 'the file was deleted while jack was writing it; the 1.0 GiB (1073741824 bytes) jack had written went with it' },
  PART_MOVED: { errno: 'ENOENT', stage: 'write_part', operation: CHECK, explanation: 'the file was moved or renamed while jack was writing it; jack\'s open handle still has 1.0 GiB (1073741824 bytes), but nothing is at this path anymore' },
  PART_REPLACED: { errno: 'ESTALE', stage: 'write_part', operation: CHECK, explanation: 'the file was replaced while jack was writing it; this path now holds a different file (inode 4211, 12 bytes) than the one jack has open (inode 4198, 1.0 GiB (1073741824 bytes))' },
  DISK_FULL: { errno: 'ENOSPC', stage: 'write_part', operation: CHUNK },
  FILE_TOO_LARGE_FOR_FS: { errno: 'EFBIG', stage: 'write_part', operation: 'writing a 65536-byte chunk to the .part at byte 4294967296' },
  FS_READ_ONLY: { errno: 'EROFS', stage: 'write_part', operation: CHUNK },
  DISK_IO_ERROR: { errno: 'EIO', stage: 'write_part', operation: 'flushing the .part to disk after 1073741824 bytes were written' },
  COMPLETED_MOVE_DENIED: { errno: 'EACCES', stage: 'move_completed', operation: MOVE },
  COMPLETED_DIR_MISSING: { errno: 'ENOENT', stage: 'move_completed', operation: MOVE },
  CROSS_DEVICE_MOVE: { errno: 'EXDEV', stage: 'move_completed', operation: MOVE },
  INVALID_PATH: { errno: 'ENAMETOOLONG', stage: 'create_part', operation: 'creating the .part file' },
  TOO_MANY_OPEN_FILES: { errno: 'EMFILE', stage: 'create_part', operation: 'creating the .part file' },
  FILESYSTEM_ERROR: { errno: 'EBADF', stage: 'write_part', operation: 'closing the .part file' },
}

// The sample paths don't exist on the machine running the seed, so the real
// inspection would report every path as missing. Replace it with what each
// failure would plausibly find on disk.
type Inspected = NonNullable<FileSystemErrorDetails['file']>
const JACK = { uid: 1000, gid: 1000 }
const ROOT = { uid: 0, gid: 0 }
const file = (path: string, mode: string, owner: typeof JACK, size: number): Inspected =>
  ({ path, exists: true, type: 'file', mode, mode_octal: octal(mode), ...owner, size_bytes: size })
const dir = (path: string, mode: string, owner: typeof JACK): Inspected =>
  ({ path, exists: true, type: 'directory', mode, mode_octal: octal(mode), ...owner })
const missing = (path: string): Inspected => ({ path, exists: false, stat_error: 'ENOENT' })
function octal(mode: string): string {
  const bits = mode.slice(1).split('').map(c => (c === '-' ? 0 : 1)).join('')
  return Number.parseInt(bits, 2).toString(8).padStart(4, '0')
}

function plausibleInspection(code: keyof typeof FS_SAMPLES, partPath: string, destPath: string, bytes: number): Partial<FileSystemErrorDetails> {
  const folder = dirname(partPath)
  const part = file(partPath, '-rw-r--r--', JACK, bytes)
  const folderOk = dir(folder, 'drwxr-xr-x', JACK)
  switch (code) {
    case 'PART_DIR_MISSING':
      return { file: missing(partPath), file_dir: missing(folder), file_nearest_existing_dir: dir('/data/torrents', 'drwxr-xr-x', JACK) }
    case 'PART_CREATE_DENIED':
      return { file: missing(partPath), file_dir: dir(folder, 'drwxr-xr-x', ROOT) }
    case 'PART_RESUME_DENIED':
      return { file: file(partPath, '-r--r--r--', ROOT, bytes), file_dir: folderOk }
    case 'PART_WRITE_DENIED':
      return { file: file(partPath, '-r--r--r--', JACK, bytes), file_dir: folderOk }
    case 'PART_DELETED':
    case 'PART_MOVED':
    case 'INVALID_PATH':
    case 'TOO_MANY_OPEN_FILES':
      return { file: missing(partPath), file_dir: folderOk }
    case 'COMPLETED_MOVE_DENIED':
      return { file: part, file_dir: folderOk, destination: file(destPath, '-rw-r--r--', ROOT, bytes) }
    case 'COMPLETED_DIR_MISSING':
      return { file: part, file_dir: folderOk, destination: missing(destPath), destination_dir: missing(dirname(destPath)) }
    case 'DISK_FULL':
      return { file: part, file_dir: folderOk, free_space: { dir: folder, bytes_available: 0, inodes_free: 120334 } }
    case 'FILE_TOO_LARGE_FOR_FS':
      return { file: file(partPath, '-rw-r--r--', JACK, 4294967295), file_dir: folderOk, free_space: { dir: folder, bytes_available: 912345678901, inodes_free: 0 } }
    case 'FS_READ_ONLY':
      return { file: part, file_dir: dir(folder, 'dr-xr-xr-x', JACK) }
    default:
      return { file: part, file_dir: folderOk }
  }
}

async function sampleError(code: DownloadErrorCode, partPath: string, destPath: string, bytes: number): Promise<{ message: string, details: FileSystemErrorDetails | null }> {
  const sample = FS_SAMPLES[code as keyof typeof FS_SAMPLES]
  if (!sample)
    return { message: MESSAGES[code] ?? code, details: null }
  const paths = sample.stage === 'move_completed' ? [partPath, destPath] : [partPath]
  const err = await fileSystemError({ ...sample, code: code as keyof typeof FS_SAMPLES, paths })
  const details: FileSystemErrorDetails = {
    code: err.details.code,
    errno: err.details.errno,
    explanation: err.details.explanation,
    operation: err.details.operation,
    occurred_at: err.details.occurred_at,
    ...plausibleInspection(code as keyof typeof FS_SAMPLES, partPath, destPath, bytes),
    process: { ...JACK, groups: '1000' },
  }
  return { message: err.message, details }
}

const { APP_CONFIG_PATH } = getAppEnvs()
const handle = await openDatabase({ appConfigPath: APP_CONFIG_PATH })
const { db } = handle
// drizzle-seed only accepts a database without a typed schema, so it gets its
// own instance over the same connection.
const seedDb = drizzle({ client: handle.sqlite })

await reset(seedDb, { downloads, peerCatalogTitles })

let firstId = 1
for (const [index, group] of GROUPS.entries()) {
  const minId = firstId
  firstId += group.count
  await seed(seedDb, { downloads }, { seed: index + 1 }).refine(f => ({
    downloads: {
      count: group.count,
      columns: {
        id: f.int({ minValue: minId, maxValue: minId + group.count - 1, isUnique: true }),
        status: f.default({ defaultValue: group.status }),
        peerName: f.valuesFromArray({ values: PEERS }),
        filename: f.valuesFromArray({ values: FILENAMES }),
        releaseSize: f.int({ minValue: 700 * MiB, maxValue: 60 * GiB }),
        expectedBytesSource: f.valuesFromArray({ values: ['content_length', 'content_range', 'release_size'] }),
        expectedBytesMismatch: f.default({ defaultValue: false }),
        attempts: f.int({ minValue: 1, maxValue: 3 }),
        lastOperation: f.default({ defaultValue: 'transfer' }),
        // Filled in the second pass, together with the error message.
        errorDetails: f.default({ defaultValue: null }),
        errorCode: group.status === 'failed'
          ? f.valuesFromArray({ values: [...DOWNLOAD_ERROR_CODES], isUnique: true })
          : f.default({ defaultValue: null }),
      },
    },
  }))
}

const now = Date.now()
for (const row of db.select().from(downloads).all()) {
  const peerId = row.peerName.toLowerCase()
  const itemId = `${peerId}:movie:${row.id}`
  const destPath = `${COMPLETED_PATH}/${row.filename}`
  const partPath = `${destPath}.part`
  const code = row.errorCode as DownloadErrorCode | null
  // A failed import means the transfer itself finished.
  const completed = row.status === 'import_queued' || row.status === 'imported' || !!code?.startsWith('IMPORT_')
  const downloadedBytes = completed ? row.releaseSize : Math.floor(row.releaseSize * ((row.id * 37) % 97) / 100)
  const failure = code ? await sampleError(code, partPath, destPath, downloadedBytes) : null
  const startedAt = now - row.id * 47 * 60_000
  const updatedAt = startedAt + (row.id % 7 + 1) * 6 * 60_000

  db.update(downloads).set({
    peerId,
    itemId,
    torrentFilename: `${row.filename}.torrent`,
    destPath,
    partPath,
    releaseJson: JSON.stringify({ id: itemId, title: row.filename.replace(/\.mkv$/, ''), filename: row.filename, category: 2000, size: row.releaseSize }),
    expectedBytes: row.releaseSize,
    downloadedBytes,
    startedAt: new Date(startedAt).toISOString(),
    updatedAt: new Date(updatedAt).toISOString(),
    completedAt: completed ? new Date(updatedAt).toISOString() : null,
    lastOperation: completed ? 'import' : 'transfer',
    operationFailed: row.status === 'failed',
    error: failure?.message ?? null,
    errorDetails: failure?.details ?? null,
    qbCategory: 'radarr',
    qbSourceServer: 'Radarr',
    sourceServerId: 'radarr',
    importMode: null,
    importTarget: null,
    manualImportCommandId: null,
  }).where(eq(downloads.id, row.id)).run()
}

const total = GROUPS.reduce((sum, group) => sum + group.count, 0)
console.log(`Seeded ${total} downloads into ${resolve(handle.path)}`)

// The catalog only shows configured peers (and drops the rest from the cache on
// refresh), so the cache is seeded under the ids of the peers in the dev config.
// Peers that answer replace their seeded titles with their live catalog on the
// next page load; offline ones keep showing the seed.
// getAppConfig writes a default config when the file is missing; don't, so a
// task that copies its own template afterwards (dev:preview) still can.
const peers = await Bun.file(APP_CONFIG_PATH).exists()
  ? (await getAppConfig({ APP_CONFIG_PATH })).appConfig.peers
  : []
const catalogCache = new CatalogCacheRepository(db)
for (const [index, peer] of peers.entries())
  catalogCache.applyPeerCatalog(generateId(peer.url), indexPeerTitles(sampleCatalog(index)))
if (peers.length === 0)
  console.log(`No peers in ${APP_CONFIG_PATH}; the peer catalog cache stays empty`)
else
  console.log(`Seeded the catalog cache for ${peers.length} peers: ${peers.map(p => p.name).join(', ')}`)

handle.close()
