import type { FileSystemErrorDetails } from '~/types/management'
import { describe, expect, test } from 'bun:test'
import { asSentence, errorCodeCounts, errorCodeGroup, errorCodeGroups, errorCodeUrl, errorHeadline, inspectionRows } from './download-errors'

describe('errorCodeUrl', () => {
  test('points at the code anchor in the troubleshooting guide', () => {
    expect(errorCodeUrl('DISK_FULL')).toBe('https://jack.roz.ninja/guide/troubleshooting#DISK_FULL')
  })
})

describe('errorHeadline', () => {
  test('joins the code and the first line of a multi-line message', () => {
    expect(errorHeadline({ errorCode: 'DISK_FULL', error: 'Filesystem error ENOSPC while writing.\nNo space left on device.' }))
      .toBe('DISK_FULL: Filesystem error ENOSPC while writing.')
  })

  test('falls back to whichever is present', () => {
    expect(errorHeadline({ errorCode: null, error: 'boom' })).toBe('boom')
    expect(errorHeadline({ errorCode: 'CANCELLED', error: null })).toBe('CANCELLED')
    expect(errorHeadline({ errorCode: null, error: null })).toBe('unknown error')
  })
})

describe('errorCodeCounts', () => {
  test('counts codes, most frequent first, ignoring rows without one', () => {
    expect(errorCodeCounts([
      { errorCode: 'PART_DELETED' },
      { errorCode: 'DISK_FULL' },
      { errorCode: null },
      { errorCode: 'DISK_FULL' },
    ])).toEqual([
      { code: 'DISK_FULL', count: 2 },
      { code: 'PART_DELETED', count: 1 },
    ])
  })
})

describe('errorCodeGroup', () => {
  test('sorts codes into the troubleshooting guide sections', () => {
    expect(errorCodeGroup('DISK_FULL')).toBe('Download file')
    expect(errorCodeGroup('PART_DELETED')).toBe('Download file')
    expect(errorCodeGroup('IDLE_TIMEOUT')).toBe('Transfer')
    expect(errorCodeGroup('UNKNOWN_ERROR')).toBe('Transfer')
    expect(errorCodeGroup('IMPORT_REJECTED')).toBe('Import')
  })
})

describe('errorCodeGroups', () => {
  test('groups present codes in guide order and drops empty groups', () => {
    expect(errorCodeGroups([
      { errorCode: 'IMPORT_REJECTED' },
      { errorCode: 'DISK_FULL' },
      { errorCode: 'DISK_FULL' },
      { errorCode: null },
    ])).toEqual([
      { group: 'Download file', codes: [{ code: 'DISK_FULL', count: 2 }] },
      { group: 'Import', codes: [{ code: 'IMPORT_REJECTED', count: 1 }] },
    ])
  })
})

describe('inspectionRows', () => {
  test('lists inspected paths in display order with labels, skipping absent roles', () => {
    const details: FileSystemErrorDetails = {
      code: 'COMPLETED_DIR_MISSING',
      errno: 'ENOENT',
      explanation: 'no such file or directory',
      operation: 'moving the completed .part into place',
      occurred_at: '2026-11-02T12:00:00.000Z',
      destination_dir: { path: '/media', exists: false, stat_error: 'ENOENT' },
      file: { path: '/dl/a.part', exists: true, type: 'file', mode: '-rw-r--r--', mode_octal: '0644', uid: 1000, gid: 1000, size_bytes: 3 },
    }
    expect(inspectionRows(details).map(row => [row.label, row.entry.path])).toEqual([
      ['File', '/dl/a.part'],
      ['Destination folder', '/media'],
    ])
  })
})

describe('asSentence', () => {
  test('capitalizes and adds a period only when missing', () => {
    expect(asSentence('no space left on device')).toBe('No space left on device.')
    expect(asSentence('Already done.')).toBe('Already done.')
  })
})
