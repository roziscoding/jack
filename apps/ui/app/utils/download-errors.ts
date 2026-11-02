import type { DownloadItem, FileSystemErrorDetails, InspectedPath } from '~/types/management'

const TROUBLESHOOTING_URL = 'https://jack.roz.ninja/guide/troubleshooting'

/** The troubleshooting guide entry for a download error code. */
export function errorCodeUrl(code: string): string {
  return `${TROUBLESHOOTING_URL}#${code}`
}

/** One line for compact lists: the code plus the first line of the message. */
export function errorHeadline(download: Pick<DownloadItem, 'error' | 'errorCode'>): string {
  const firstLine = download.error?.split('\n', 1)[0]?.trim()
  if (download.errorCode && firstLine)
    return `${download.errorCode}: ${firstLine}`
  return download.errorCode ?? firstLine ?? 'unknown error'
}

/** Error codes among `downloads`, most frequent first, for the filter. */
export function errorCodeCounts(downloads: Pick<DownloadItem, 'errorCode'>[]): Array<{ code: string, count: number }> {
  const counts = new Map<string, number>()
  for (const d of downloads) {
    if (d.errorCode)
      counts.set(d.errorCode, (counts.get(d.errorCode) ?? 0) + 1)
  }
  return Array.from(counts, ([code, count]) => ({ code, count })).sort((a, b) => b.count - a.count || a.code.localeCompare(b.code))
}

// Codes about the download's own file (the `.part` and its move into place).
// Mirrors FILE_SYSTEM_ERROR_CODES in the backend and the "Download file" table
// of the troubleshooting guide.
const FILE_CODES = new Set([
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
])

/** The troubleshooting guide section an error code belongs to. */
export type ErrorCodeGroup = 'Download file' | 'Transfer' | 'Import'
const GROUP_ORDER: ErrorCodeGroup[] = ['Download file', 'Transfer', 'Import']

export function errorCodeGroup(code: string): ErrorCodeGroup {
  if (code.startsWith('IMPORT_'))
    return 'Import'
  return FILE_CODES.has(code) ? 'Download file' : 'Transfer'
}

/**
 * The codes among `downloads`, grouped like the troubleshooting guide, each
 * with its count. Empty groups are left out.
 */
export function errorCodeGroups(downloads: Pick<DownloadItem, 'errorCode'>[]): Array<{ group: ErrorCodeGroup, codes: Array<{ code: string, count: number }> }> {
  const counts = errorCodeCounts(downloads)
  return GROUP_ORDER
    .map(group => ({ group, codes: counts.filter(({ code }) => errorCodeGroup(code) === group) }))
    .filter(({ codes }) => codes.length > 0)
}

const ROLE_LABELS: Array<[keyof FileSystemErrorDetails, string]> = [
  ['file', 'File'],
  ['file_dir', 'Folder'],
  ['file_nearest_existing_dir', 'Nearest existing folder'],
  ['destination', 'Destination'],
  ['destination_dir', 'Destination folder'],
  ['destination_nearest_existing_dir', 'Nearest existing destination folder'],
]

/** The paths jack inspected, in display order, each with a plain label. */
export function inspectionRows(details: FileSystemErrorDetails): Array<{ label: string, entry: InspectedPath }> {
  return ROLE_LABELS.flatMap(([key, label]) => {
    const entry = details[key] as InspectedPath | undefined
    return entry ? [{ label, entry }] : []
  })
}

const ENDS_WITH_PUNCTUATION = /[.!?]$/

/** Capitalize and end with a period: explanations are stored as fragments. */
export function asSentence(text: string): string {
  const trimmed = text.trim()
  if (!trimmed)
    return trimmed
  const capitalized = trimmed.charAt(0).toUpperCase() + trimmed.slice(1)
  return ENDS_WITH_PUNCTUATION.test(capitalized) ? capitalized : `${capitalized}.`
}
