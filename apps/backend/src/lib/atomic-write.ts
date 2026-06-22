import { chmod, rename, stat, unlink } from 'node:fs/promises'

/**
 * Write `contents` to `path` atomically: write a uniquely-named sibling temp file
 * then rename it over the target. rename(2) within a directory is atomic, so a
 * reader never sees a half-written file and a crash mid-write leaves the original
 * intact.
 *
 * - The temp name is randomized (not a fixed `.tmp`) to avoid clobbering/symlink
 *   races and concurrent-writer collisions.
 * - Permissions are preserved from the existing target; a brand-new file defaults to
 *   owner-only (`0o600`) since config may carry secrets.
 * - On any failure the temp file is cleaned up.
 */
export async function atomicWriteFile(path: string, contents: string): Promise<void> {
  const tmp = `${path}.${crypto.randomUUID()}.tmp`
  try {
    await Bun.write(tmp, contents)
    const mode = await stat(path).then(s => s.mode & 0o777).catch(() => 0o600)
    await chmod(tmp, mode)
    await rename(tmp, path)
  }
  catch (err) {
    await unlink(tmp).catch(() => {})
    throw err
  }
}
