import type { DownloadItem } from '~/types/management'

export type DownloadAction = 'cancel' | 'retry' | 'delete'

/** Actions supported by the persisted operation state, not just the display status. */
export function downloadActionsFor(download: DownloadItem): DownloadAction[] {
  const canRetry = download.operationFailed && (download.lastOperation === 'transfer'
    || (download.lastOperation === 'import' && download.importMode === 'jack_manual' && download.importTarget != null))
  if (canRetry)
    return ['retry', 'delete']
  if (download.status === 'downloading')
    return ['cancel', 'delete']
  return ['delete']
}
