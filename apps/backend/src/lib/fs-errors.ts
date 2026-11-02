import type { Stats } from 'node:fs'
import type { FileHandle } from 'node:fs/promises'
import type { FileSystemErrorCode, FileSystemErrorDetails, InspectedPath } from './errors/FileSystemError'
import { stat, statfs } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import process from 'node:process'
import { FileSystemError } from './errors/FileSystemError'

/** What each errno means for a file jack is reading, writing, or moving. */
const ERRNO_EXPLANATIONS: Record<string, string> = {
  EACCES: 'permission denied: the mode or owner of the path or its parent directory does not allow this for jack\'s user',
  EPERM: 'operation not permitted: usually ownership (sticky bit, chown), an immutable attribute, or the filesystem refusing the call',
  ENOENT: 'no such file or directory: the path or one of its parent directories does not exist (deleted or moved while jack was using it, or never created)',
  ENOTDIR: 'a component of the path is not a directory',
  EISDIR: 'the path is a directory, not a file',
  EEXIST: 'the path already exists',
  ENOSPC: 'no space left on device (or no free inodes)',
  EDQUOT: 'disk quota exceeded for jack\'s user',
  EFBIG: 'file too large for this filesystem (for example, over 4 GiB on FAT32)',
  EROFS: 'read-only filesystem: the mount is read-only or was remounted read-only, often after disk errors',
  EIO: 'I/O error from the storage device or network filesystem; check the kernel log (dmesg)',
  ESTALE: 'stale file handle: a network filesystem (NFS) removed or replaced the file on the server',
  EXDEV: 'cross-device rename: the source and destination are on different filesystems or mounts',
  ENAMETOOLONG: 'the path or file name is too long for this filesystem',
  ELOOP: 'too many levels of symbolic links in the path',
  EMFILE: 'jack hit its per-process open-file limit (ulimit -n)',
  ENFILE: 'the system-wide open-file limit was reached',
  EBUSY: 'the path is busy (a mount point, or locked by another process)',
  ETXTBSY: 'the file is in use as an executable',
  EBADF: 'the file handle was already closed',
  EINVAL: 'invalid argument: the filesystem does not support this operation on this path',
  ENOTSUP: 'the filesystem does not support this operation',
  EOPNOTSUPP: 'the filesystem does not support this operation',
}

/** Errnos where the free space of the target filesystem explains the failure. */
const SPACE_ERRNOS = new Set(['ENOSPC', 'EDQUOT', 'EFBIG'])

/** Which step of handling the download's file failed. Picks the jack code. */
export type FsStage = 'create_part' | 'resume_part' | 'write_part' | 'move_completed'

const STAGE_DENIED: Record<FsStage, FileSystemErrorCode> = {
  create_part: 'PART_CREATE_DENIED',
  resume_part: 'PART_RESUME_DENIED',
  write_part: 'PART_WRITE_DENIED',
  move_completed: 'COMPLETED_MOVE_DENIED',
}

function classify(errno: string, stage: FsStage, inspected: Partial<Record<InspectedKey, InspectedPath>>): FileSystemErrorCode {
  switch (errno) {
    case 'ENOSPC':
    case 'EDQUOT':
      return 'DISK_FULL'
    case 'EFBIG':
      return 'FILE_TOO_LARGE_FOR_FS'
    case 'EROFS':
      return 'FS_READ_ONLY'
    case 'EIO':
      return 'DISK_IO_ERROR'
    case 'ESTALE':
      return 'PART_REPLACED'
    case 'EXDEV':
      return 'CROSS_DEVICE_MOVE'
    case 'EMFILE':
    case 'ENFILE':
      return 'TOO_MANY_OPEN_FILES'
    case 'ENAMETOOLONG':
    case 'ELOOP':
    case 'EISDIR':
    case 'ENOTDIR':
      return 'INVALID_PATH'
    case 'EACCES':
    case 'EPERM':
      return STAGE_DENIED[stage]
    case 'ENOENT':
      if (stage === 'create_part')
        return 'PART_DIR_MISSING'
      if (stage === 'move_completed' && inspected.file?.exists)
        return inspected.destination_dir?.exists === false ? 'COMPLETED_DIR_MISSING' : 'FILESYSTEM_ERROR'
      return 'PART_DELETED'
    default:
      return 'FILESYSTEM_ERROR'
  }
}

type PathRole = 'file' | 'destination'
type InspectedKey = `${PathRole}${'' | '_dir' | '_nearest_existing_dir'}`

const ROLE_LABELS: Record<InspectedKey, string> = {
  file: 'File',
  file_dir: 'Folder',
  file_nearest_existing_dir: 'Nearest existing folder',
  destination: 'Destination',
  destination_dir: 'Destination folder',
  destination_nearest_existing_dir: 'Nearest existing destination folder',
}

export function isErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && 'code' in err && typeof err.code === 'string'
}

function explain(errno: string): string {
  return ERRNO_EXPLANATIONS[errno] ?? 'unrecognized filesystem error'
}

/** `drwxr-x---`, like `ls -l`. */
export function symbolicMode(stats: Stats): string {
  const bits = 'rwxrwxrwx'
  let symbolic = stats.isDirectory() ? 'd' : '-'
  for (let i = 0; i < 9; i++)
    symbolic += stats.mode & (1 << (8 - i)) ? bits[i] : '-'
  return symbolic
}

function humanBytes(bytes: number): string {
  const units = ['bytes', 'KiB', 'MiB', 'GiB', 'TiB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return unit === 0 ? `${bytes} bytes` : `${value.toFixed(1)} ${units[unit]} (${bytes} bytes)`
}

async function inspect(path: string): Promise<InspectedPath> {
  try {
    const stats = await stat(path)
    const type = stats.isDirectory() ? 'directory' : stats.isFile() ? 'file' : 'other'
    return {
      path,
      exists: true,
      type,
      mode: symbolicMode(stats),
      mode_octal: (stats.mode & 0o7777).toString(8).padStart(4, '0'),
      uid: stats.uid,
      gid: stats.gid,
      ...(type === 'directory' ? {} : { size_bytes: stats.size }),
    }
  }
  catch (err) {
    return { path, exists: false, stat_error: isErrnoException(err) ? err.code! : 'unknown error' }
  }
}

/**
 * Inspect each path and its parent directory. When the parent is missing too,
 * walk up to the nearest ancestor that exists, so the error shows where the
 * tree stops. A directory already inspected under another role is skipped.
 */
async function inspectPaths(paths: string[]): Promise<Partial<Record<InspectedKey, InspectedPath>>> {
  const roles: PathRole[] = ['file', 'destination']
  const seen = new Set<string>()
  const out: Partial<Record<InspectedKey, InspectedPath>> = {}

  for (const [i, path] of paths.entries()) {
    const role = roles[i]
    if (!role)
      break
    out[role] = await inspect(path)
    seen.add(path)

    let dir = dirname(path)
    if (seen.has(dir))
      continue
    seen.add(dir)
    const parent = await inspect(dir)
    out[`${role}_dir`] = parent
    if (parent.exists || parent.stat_error !== 'ENOENT')
      continue

    while (dirname(dir) !== dir) {
      dir = dirname(dir)
      const ancestor = await inspect(dir)
      if (ancestor.exists) {
        if (!seen.has(dir))
          out[`${role}_nearest_existing_dir`] = ancestor
        seen.add(dir)
        break
      }
    }
  }
  return out
}

async function inspectFreeSpace(dir: string): Promise<NonNullable<FileSystemErrorDetails['free_space']>> {
  try {
    const fs = await statfs(dir)
    return { dir, bytes_available: fs.bavail * fs.bsize, inodes_free: fs.ffree }
  }
  catch (err) {
    return { dir, statfs_error: isErrnoException(err) ? err.code! : 'unknown error' }
  }
}

function inspectProcess(): FileSystemErrorDetails['process'] {
  const uid = process.getuid?.()
  const gid = process.getgid?.()
  if (uid == null || gid == null)
    return undefined
  return { uid, gid, groups: process.getgroups?.().join(',') ?? '' }
}

function describeInspected(entry: InspectedPath): string {
  if (!entry.exists)
    return entry.stat_error === 'ENOENT' ? 'does not exist' : `could not be inspected (${entry.stat_error})`
  const size = entry.size_bytes == null ? '' : `, ${humanBytes(entry.size_bytes)}`
  return `${entry.mode} (${entry.mode_octal}), owner uid ${entry.uid}, gid ${entry.gid}${size}`
}

function humanMessage(details: FileSystemErrorDetails): string {
  const explanation = details.explanation.charAt(0).toUpperCase() + details.explanation.slice(1)
  const lines = [
    `Filesystem error ${details.errno} while ${details.operation}.`,
    `${explanation}.`,
    `When: ${details.occurred_at}`,
  ]
  for (const key of Object.keys(ROLE_LABELS) as InspectedKey[]) {
    const entry = details[key]
    if (entry)
      lines.push(`${ROLE_LABELS[key]}: ${entry.path}`, `  ${describeInspected(entry)}`)
  }
  const free = details.free_space
  if (free) {
    lines.push('bytes_available' in free
      ? `Free space on ${free.dir}: ${humanBytes(free.bytes_available)}, ${free.inodes_free} free inodes`
      : `Free space on ${free.dir}: could not be checked (${free.statfs_error})`)
  }
  if (details.process)
    lines.push(`jack runs as uid ${details.process.uid}, gid ${details.process.gid}${details.process.groups ? `, groups ${details.process.groups}` : ''}`)
  return lines.join('\n')
}

interface FileSystemErrorInput {
  errno: string
  stage: FsStage
  operation: string
  /** `[file]`, or `[source, destination]` for a rename. */
  paths: string[]
  /** Overrides the code derived from errno and stage, for failures jack detected itself. */
  code?: FileSystemErrorCode
  /** Overrides the generic errno explanation, for failures jack detected itself. */
  explanation?: string
  cause?: unknown
}

/**
 * Build a {@link FileSystemError}. The paths, their parent directories, and
 * (for space errors) the free space are inspected at the time of the failure,
 * so the error shows what jack actually found on disk.
 */
export async function fileSystemError(input: FileSystemErrorInput): Promise<FileSystemError> {
  const absolute = input.paths.map(p => resolve(p))
  const occurredAt = new Date().toISOString()
  const inspected = await inspectPaths(absolute)
  const details: FileSystemErrorDetails = {
    code: input.code ?? classify(input.errno, input.stage, inspected),
    errno: input.errno,
    explanation: input.explanation ?? explain(input.errno),
    operation: input.operation,
    occurred_at: occurredAt,
    ...inspected,
  }
  const target = absolute.at(-1)
  if (SPACE_ERRNOS.has(input.errno) && target)
    details.free_space = await inspectFreeSpace(dirname(target))
  details.process = inspectProcess()

  const summary = `[${details.code}] Filesystem error ${input.errno} while ${input.operation}: ${absolute.join(' -> ')}`
  return new FileSystemError(humanMessage(details), summary, details, input.cause)
}

/**
 * Run `fn`; if it rejects with an errno error (EACCES, EPERM, ENOSPC, ENOENT,
 * ...), replace it with a {@link FileSystemError} describing `paths`. Errors
 * without an errno code pass through unchanged.
 */
export async function withFsContext<T>(stage: FsStage, operation: string, paths: string[], fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  }
  catch (err) {
    if (err instanceof FileSystemError || !isErrnoException(err))
      throw err
    throw await fileSystemError({ errno: err.code!, stage, operation, paths, cause: err })
  }
}

/**
 * Writes to an open handle keep succeeding after the file is deleted, moved, or
 * replaced: they land in an inode that is no longer at `path`. Compare the
 * handle's inode with what `path` points to now and throw if they diverged.
 */
export async function assertHandleAtPath(handle: FileHandle, path: string, operation: string): Promise<void> {
  const fdStats = await withFsContext('write_part', operation, [path], () => handle.stat())
  const fail = (errno: string, code: FileSystemErrorCode | undefined, explanation: string) =>
    fileSystemError({ errno, stage: 'write_part', code, operation, paths: [path], explanation })

  if (fdStats.nlink === 0)
    throw await fail('ENOENT', 'PART_DELETED', `the file was deleted while jack was writing it; the ${humanBytes(fdStats.size)} jack had written went with it`)

  let current: Stats
  try {
    current = await stat(path)
  }
  catch (err) {
    const errno = isErrnoException(err) ? err.code! : 'unknown error'
    if (errno === 'ENOENT')
      throw await fail('ENOENT', 'PART_MOVED', `the file was moved or renamed while jack was writing it; jack's open handle still has ${humanBytes(fdStats.size)}, but nothing is at this path anymore`)
    throw await fail(errno, undefined, `could not check the file jack is writing: ${explain(errno)}`)
  }
  if (current.ino !== fdStats.ino || current.dev !== fdStats.dev)
    throw await fail('ESTALE', 'PART_REPLACED', `the file was replaced while jack was writing it; this path now holds a different file (inode ${current.ino}, ${humanBytes(current.size)}) than the one jack has open (inode ${fdStats.ino}, ${humanBytes(fdStats.size)})`)
}
