import { rename } from 'node:fs/promises'

/**
 * Write `contents` to `path` atomically: write a sibling `.tmp` file then rename it
 * over the target. rename(2) within a directory is atomic, so a reader never sees a
 * half-written config and a crash mid-write leaves the original intact.
 */
export async function atomicWriteFile(path: string, contents: string): Promise<void> {
  const tmp = `${path}.tmp`
  await Bun.write(tmp, contents)
  await rename(tmp, path)
}
