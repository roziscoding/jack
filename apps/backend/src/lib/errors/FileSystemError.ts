import { AppError } from './AppError'

/**
 * jack's code for a filesystem failure: what happened to the download's file,
 * more specific than the errno. Documented in the troubleshooting guide.
 */
export const FILE_SYSTEM_ERROR_CODES = [
  'PART_DIR_MISSING',
  'PART_CREATE_DENIED',
  'PART_RESUME_DENIED',
  'PART_WRITE_DENIED',
  'PART_DELETED',
  'PART_MOVED',
  'PART_REPLACED',
  'DISK_FULL',
  'FILE_TOO_LARGE_FOR_FS',
  'FS_READ_ONLY',
  'DISK_IO_ERROR',
  'COMPLETED_MOVE_DENIED',
  'COMPLETED_DIR_MISSING',
  'CROSS_DEVICE_MOVE',
  'INVALID_PATH',
  'TOO_MANY_OPEN_FILES',
  'FILESYSTEM_ERROR',
] as const
export type FileSystemErrorCode = typeof FILE_SYSTEM_ERROR_CODES[number]

/** What jack found at one path when the error happened. */
export type InspectedPath
  = | { path: string, exists: true, type: 'file' | 'directory' | 'other', mode: string, mode_octal: string, uid: number, gid: number, size_bytes?: number }
    | { path: string, exists: false, stat_error: string }

/**
 * Structured context for logs. Keys are flat roles rather than arrays so the
 * logs screen shows them as `filesystem.file.mode`, `filesystem.file_dir.uid`...
 */
export interface FileSystemErrorDetails {
  code: FileSystemErrorCode
  errno: string
  explanation: string
  operation: string
  occurred_at: string
  file?: InspectedPath
  file_dir?: InspectedPath
  file_nearest_existing_dir?: InspectedPath
  destination?: InspectedPath
  destination_dir?: InspectedPath
  destination_nearest_existing_dir?: InspectedPath
  free_space?: { dir: string, bytes_available: number, inodes_free: number } | { dir: string, statfs_error: string }
  process?: { uid: number, gid: number, groups: string }
}

/**
 * A filesystem call failed, or the file jack was writing changed under it.
 *
 * - `code`: jack's {@link FileSystemErrorCode}.
 * - `message`: multi-line, human-readable. Stored as the download's error.
 * - `summary`: one line, for the `error` field of a log record.
 * - `details`: structured context, for the log record's fields.
 */
export class FileSystemError extends AppError {
  declare public readonly code: FileSystemErrorCode

  constructor(
    message: string,
    public readonly summary: string,
    public readonly details: FileSystemErrorDetails,
    cause?: unknown,
  ) {
    super(message, details.code, { cause })
  }

  get errno(): string {
    return this.details.errno
  }
}
