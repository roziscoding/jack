import { describe, expect, test } from 'bun:test'
import { downloadActionsFor } from './download-actions'

function item(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    filename: 'movie.mkv',
    peerName: 'Peer',
    peerId: 'peer-1',
    status: 'failed',
    downloadedBytes: 5,
    totalBytes: 10,
    progress: 0.5,
    releaseSize: 10,
    attempts: 1,
    error: 'boom',
    lastOperation: 'transfer',
    operationFailed: true,
    startedAt: '',
    updatedAt: '',
    completedAt: null,
    expectedBytesMismatch: false,
    ...overrides,
  } as any
}

describe('downloadActionsFor', () => {
  test('offers cancel and delete for an active transfer', () => {
    expect(downloadActionsFor(item({ status: 'downloading', operationFailed: false }))).toEqual(['cancel', 'delete'])
  })

  test('offers retry for transfer failures and supported manual import failures', () => {
    expect(downloadActionsFor(item())).toEqual(['retry', 'delete'])
    expect(downloadActionsFor(item({ lastOperation: 'import', importMode: 'jack_manual', importTarget: { kind: 'movie', movieId: 42 } }))).toEqual(['retry', 'delete'])
  })

  test('does not offer retry for an import failure the backend cannot re-trigger', () => {
    expect(downloadActionsFor(item({ lastOperation: 'import', importMode: null, importTarget: null }))).toEqual(['delete'])
    expect(downloadActionsFor(item({ lastOperation: 'import', importMode: 'jack_manual', importTarget: null }))).toEqual(['delete'])
  })

  test('offers only delete when there is no failed operation', () => {
    expect(downloadActionsFor(item({ status: 'failed', operationFailed: false }))).toEqual(['delete'])
  })
})
