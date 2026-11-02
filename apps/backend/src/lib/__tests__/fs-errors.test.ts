import type { FileSystemErrorCode } from '../errors/FileSystemError'
import type { FsStage } from '../fs-errors'
import { chmod, link, mkdtemp, open, rename, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { FileSystemError } from '../errors/FileSystemError'
import { assertHandleAtPath, withFsContext } from '../fs-errors'

const isRoot = process.getuid?.() === 0

function errnoError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: simulated`), { code })
}

async function fsRejection(promise: Promise<unknown>): Promise<FileSystemError> {
  const err = await promise.then(() => null, (e: unknown) => e)
  expect(err).toBeInstanceOf(FileSystemError)
  return err as FileSystemError
}

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'jack-fs-errors-'))
})

afterEach(async () => {
  await chmod(dir, 0o755).catch(() => {})
  await rm(dir, { recursive: true, force: true })
})

describe('withFsContext', () => {
  test.skipIf(isRoot)('turns EACCES into a FileSystemError with a human message, a summary, and structured details', async () => {
    const file = join(dir, 'movie.mkv.part')
    await writeFile(file, 'partial')
    await chmod(file, 0o444)

    const err = await fsRejection(withFsContext('resume_part', 'opening the .part to resume at byte 7', [file], () => open(file, 'a')))

    expect(err.code).toBe('PART_RESUME_DENIED')
    expect(err.errno).toBe('EACCES')
    expect(err.summary).toBe(`[PART_RESUME_DENIED] Filesystem error EACCES while opening the .part to resume at byte 7: ${file}`)

    expect(err.details).toMatchObject({
      code: 'PART_RESUME_DENIED',
      errno: 'EACCES',
      operation: 'opening the .part to resume at byte 7',
      file: { path: file, exists: true, type: 'file', mode: '-r--r--r--', mode_octal: '0444', uid: process.getuid?.(), gid: process.getgid?.(), size_bytes: 7 },
      file_dir: { path: dir, exists: true, type: 'directory', mode: 'drwx------', mode_octal: '0700' },
      process: { uid: process.getuid?.(), gid: process.getgid?.() },
    })
    expect(err.details.explanation).toStartWith('permission denied')
    expect(err.details.occurred_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)

    const lines = err.message.split('\n')
    expect(lines[0]).toBe('Filesystem error EACCES while opening the .part to resume at byte 7.')
    expect(lines[1]).toStartWith('Permission denied: ')
    expect(lines[2]).toBe(`When: ${err.details.occurred_at}`)
    expect(err.message).toContain(`File: ${file}\n  -r--r--r-- (0444), owner uid ${process.getuid?.()}, gid ${process.getgid?.()}, 7 bytes`)
    expect(err.message).toContain(`Folder: ${dir}\n  drwx------ (0700)`)
    expect(err.message).toContain(`jack runs as uid ${process.getuid?.()}, gid ${process.getgid?.()}`)
  })

  test.skipIf(isRoot)('reports a missing file and its unwritable parent directory', async () => {
    const file = join(dir, 'new.part')
    await chmod(dir, 0o555)

    const err = await fsRejection(withFsContext('create_part', 'creating the .part file', [file], () => open(file, 'w')))

    expect(err.code).toBe('PART_CREATE_DENIED')
    expect(err.details.file).toEqual({ path: file, exists: false, stat_error: 'ENOENT' })
    expect(err.details.file_dir).toMatchObject({ path: dir, mode: 'dr-xr-xr-x' })
    expect(err.message).toContain(`File: ${file}\n  does not exist`)
  })

  test('shows both sides of a rename and the nearest existing folder', async () => {
    const from = join(dir, 'a.part')
    const to = join(dir, 'missing', 'a.mkv')
    await writeFile(from, 'x')

    const err = await fsRejection(withFsContext('move_completed', 'moving the completed .part into place', [from, to], () => rename(from, to)))

    expect(err.errno).toBe('ENOENT')
    expect(err.code).toBe('COMPLETED_DIR_MISSING')
    expect(err.summary).toEndWith(`${from} -> ${to}`)
    expect(err.details.file).toMatchObject({ path: from, exists: true })
    expect(err.details.destination).toEqual({ path: to, exists: false, stat_error: 'ENOENT' })
    expect(err.details.destination_dir).toEqual({ path: join(dir, 'missing'), exists: false, stat_error: 'ENOENT' })
    // dir was already inspected as the file's folder, so it is not repeated.
    expect(err.details.destination_nearest_existing_dir).toBeUndefined()
    expect(err.message).toContain(`Destination folder: ${join(dir, 'missing')}\n  does not exist`)
  })

  test('reports a rename whose source is gone as PART_DELETED', async () => {
    const from = join(dir, 'gone.part')
    const to = join(dir, 'gone.mkv')
    const err = await fsRejection(withFsContext('move_completed', 'moving the completed .part into place', [from, to], () => rename(from, to)))
    expect(err.code).toBe('PART_DELETED')
  })

  test('walks up to the nearest existing folder', async () => {
    const file = join(dir, 'gone', 'deeper', 'x.part')
    const err = await fsRejection(withFsContext('create_part', 'creating the .part file', [file], () => open(file, 'w')))

    expect(err.code).toBe('PART_DIR_MISSING')
    expect(err.details.file_dir).toEqual({ path: join(dir, 'gone', 'deeper'), exists: false, stat_error: 'ENOENT' })
    expect(err.details.file_nearest_existing_dir).toMatchObject({ path: dir, exists: true, type: 'directory' })
    expect(err.message).toContain(`Nearest existing folder: ${dir}`)
  })

  test('adds free space for ENOSPC', async () => {
    const err = await fsRejection(withFsContext('write_part', 'writing', [join(dir, 'x.part')], () => Promise.reject(errnoError('ENOSPC'))))

    expect(err.code).toBe('DISK_FULL')
    expect(err.details.free_space).toMatchObject({ dir, bytes_available: expect.any(Number), inodes_free: expect.any(Number) })
    expect(err.message).toContain('No space left on device')
    expect(err.message).toMatch(new RegExp(`Free space on ${dir}: .+, \\d+ free inodes`))
  })

  test('handles EPERM', async () => {
    const err = await fsRejection(withFsContext('move_completed', 'moving', [join(dir, 'x'), join(dir, 'y')], () => Promise.reject(errnoError('EPERM'))))
    expect(err.code).toBe('COMPLETED_MOVE_DENIED')
    expect(err.details.explanation).toStartWith('operation not permitted')
  })

  test('keeps unknown errno codes', async () => {
    const err = await fsRejection(withFsContext('write_part', 'writing', [join(dir, 'x')], () => Promise.reject(errnoError('EWEIRD'))))
    expect(err.code).toBe('FILESYSTEM_ERROR')
    expect(err.errno).toBe('EWEIRD')
    expect(err.details.explanation).toBe('unrecognized filesystem error')
  })

  test('passes errors without an errno code through unchanged', async () => {
    const original = new Error('nope')
    const err = await withFsContext('write_part', 'writing', [join(dir, 'x')], () => Promise.reject(original)).then(() => null, (e: unknown) => e)
    expect(err).toBe(original)
  })
})

describe('jack codes', () => {
  const cases: Array<[FsStage, string, FileSystemErrorCode]> = [
    ['create_part', 'EACCES', 'PART_CREATE_DENIED'],
    ['resume_part', 'EPERM', 'PART_RESUME_DENIED'],
    ['write_part', 'EACCES', 'PART_WRITE_DENIED'],
    ['move_completed', 'EACCES', 'COMPLETED_MOVE_DENIED'],
    ['create_part', 'ENOENT', 'PART_DIR_MISSING'],
    ['resume_part', 'ENOENT', 'PART_DELETED'],
    ['write_part', 'ENOENT', 'PART_DELETED'],
    ['write_part', 'ENOSPC', 'DISK_FULL'],
    ['write_part', 'EDQUOT', 'DISK_FULL'],
    ['write_part', 'EFBIG', 'FILE_TOO_LARGE_FOR_FS'],
    ['write_part', 'EROFS', 'FS_READ_ONLY'],
    ['write_part', 'EIO', 'DISK_IO_ERROR'],
    ['write_part', 'ESTALE', 'PART_REPLACED'],
    ['move_completed', 'EXDEV', 'CROSS_DEVICE_MOVE'],
    ['create_part', 'ENAMETOOLONG', 'INVALID_PATH'],
    ['create_part', 'ELOOP', 'INVALID_PATH'],
    ['create_part', 'EISDIR', 'INVALID_PATH'],
    ['create_part', 'ENOTDIR', 'INVALID_PATH'],
    ['create_part', 'EMFILE', 'TOO_MANY_OPEN_FILES'],
    ['create_part', 'ENFILE', 'TOO_MANY_OPEN_FILES'],
    ['write_part', 'EBADF', 'FILESYSTEM_ERROR'],
  ]

  test.each(cases)('%s + %s -> %s', async (stage, errno, code) => {
    const paths = stage === 'move_completed' ? [join(dir, 'x.part'), join(dir, 'x.mkv')] : [join(dir, 'x.part')]
    const err = await fsRejection(withFsContext(stage, 'doing it', paths, () => Promise.reject(errnoError(errno))))
    expect(err.code).toBe(code)
    expect(err.summary).toStartWith(`[${code}] Filesystem error ${errno} while doing it: `)
  })
})

describe('assertHandleAtPath', () => {
  test('passes while the handle still points at the path', async () => {
    const file = join(dir, 'ok.part')
    const handle = await open(file, 'w')
    try {
      await handle.write(new Uint8Array(4))
      await assertHandleAtPath(handle, file, 'writing')
    }
    finally {
      await handle.close()
    }
  })

  test('detects a deleted file', async () => {
    const file = join(dir, 'deleted.part')
    const handle = await open(file, 'w')
    try {
      await handle.write(new Uint8Array(4))
      await unlink(file)
      await handle.write(new Uint8Array(4))

      const err = await fsRejection(assertHandleAtPath(handle, file, 'writing'))
      expect(err.errno).toBe('ENOENT')
      expect(err.code).toBe('PART_DELETED')
      expect(err.details.explanation).toBe('the file was deleted while jack was writing it; the 8 bytes jack had written went with it')
    }
    finally {
      await handle.close()
    }
  })

  test('detects a moved file', async () => {
    const file = join(dir, 'moved.part')
    const handle = await open(file, 'w')
    try {
      await handle.write(new Uint8Array(4))
      await rename(file, join(dir, 'elsewhere'))

      const err = await fsRejection(assertHandleAtPath(handle, file, 'writing'))
      expect(err.errno).toBe('ENOENT')
      expect(err.code).toBe('PART_MOVED')
      expect(err.details.explanation).toStartWith('the file was moved or renamed while jack was writing it')
    }
    finally {
      await handle.close()
    }
  })

  test('detects a replaced file', async () => {
    const file = join(dir, 'replaced.part')
    const handle = await open(file, 'w')
    try {
      await handle.write(new Uint8Array(4))
      // Keep the original inode linked elsewhere, then put another file at the path.
      await link(file, join(dir, 'original-elsewhere'))
      await writeFile(join(dir, 'other'), 'someone else')
      await rename(join(dir, 'other'), file)

      const err = await fsRejection(assertHandleAtPath(handle, file, 'writing'))
      expect(err.errno).toBe('ESTALE')
      expect(err.code).toBe('PART_REPLACED')
      expect(err.details.explanation).toMatch(/the file was replaced while jack was writing it; this path now holds a different file \(inode \d+, 12 bytes\) than the one jack has open \(inode \d+, 4 bytes\)/)
    }
    finally {
      await handle.close()
    }
  })
})
