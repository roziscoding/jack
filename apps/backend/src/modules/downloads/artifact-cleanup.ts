import type { DownloadsRepository } from './downloads.repository'
import { unlink } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'

type ArtifactRepository = Pick<DownloadsRepository, 'get' | 'list'>

/**
 * Drop jack's directory entry for one download artifact. Deliberately `unlink` and
 * nothing more: when *arr hardlinked the file into the library, removing jack's link
 * frees the name while the library's link keeps the data alive; when *arr copied it,
 * the copy is untouched either way.
 *
 * Three guards, all evaluated immediately before the syscall so a concurrent
 * delete/retry can't be raced into removing a file that is no longer ours:
 * - the path must resolve inside `completedPath` (never follow a row out of the root)
 * - the live row must still reference it (it may have been deleted or rewritten)
 * - no other download row may reference it (a sibling still owns the shared file)
 *
 * A missing file (ENOENT) is success, not an error. Returns whether a file was
 * actually removed.
 */
export async function unlinkDownloadArtifact(
  repository: ArtifactRepository,
  id: number,
  artifactPath: string,
  completedPath: string,
): Promise<boolean> {
  const resolved = resolve(artifactPath)
  const fromRoot = relative(resolve(completedPath), resolved)
  const isInsideRoot = fromRoot !== '' && !fromRoot.startsWith('..') && !isAbsolute(fromRoot)
  if (!isInsideRoot)
    return false

  const live = repository.get(id)
  const stillOwned = live != null && [resolve(live.partPath), resolve(live.destPath)].includes(resolved)
  if (!stillOwned)
    return false

  const siblingOwns = repository.list().some(row => row.id !== id
    && [resolve(row.destPath), resolve(row.partPath)].includes(resolved))
  if (siblingOwns)
    return false

  try {
    await unlink(resolved)
    return true
  }
  catch (err) {
    if (err instanceof Error && 'code' in err && err.code === 'ENOENT')
      return false
    throw err
  }
}
