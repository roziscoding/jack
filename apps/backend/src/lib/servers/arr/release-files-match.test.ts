import type { Release } from '../../release'
import { describe, expect, test } from 'bun:test'
import { releaseFilesMatch } from './base'

function release(overrides: Partial<Release>): Release {
  return {
    id: 'r',
    title: 'Movie.2024.2160p.BluRay.REMUX-GRP',
    filename: 'Movie.2024.2160p.mkv',
    category: 2000,
    size: 1000,
    ...overrides,
  } as Release
}

describe('releaseFilesMatch', () => {
  test('matches on identical byte size even when titles differ', () => {
    const queued = release({ title: 'Movie.2024.REMUX-GRP', size: 57191006013 })
    // *arr renames the file on import, so the on-disk title looks nothing alike.
    const onDisk = release({ title: 'Movie (2024) [tmdbid-1] - [Remux-2160p]', size: 57191006013 })
    expect(releaseFilesMatch(queued, onDisk)).toBe(true)
  })

  test('matches on normalized title when sizes are recorded differently', () => {
    const queued = release({ title: 'Movie.2024.2160p.BluRay.REMUX-GRP', size: 1000 })
    const onDisk = release({ title: 'movie 2024 2160p bluray remux grp', size: 999 })
    expect(releaseFilesMatch(queued, onDisk)).toBe(true)
  })

  test('does NOT match on release group + quality tier alone (size and title differ)', () => {
    // A different edition of the same movie can share group + quality; retiring on
    // that would drop a still-missing release.
    const queued = release({ title: 'A', size: 1000, releaseGroup: 'FraMeSToR', quality: { name: 'Remux-2160p' } })
    const onDisk = release({ title: 'B', size: 2000, releaseGroup: 'framestor', quality: { name: 'Remux-2160p' } })
    expect(releaseFilesMatch(queued, onDisk)).toBe(false)
  })

  test('does not match another episode of the same series that shares group + quality', () => {
    // Sonarr's whole-series scan hands us every on-disk episode; a sibling episode
    // from the same group/quality must not retire this row.
    const queued = release({ title: 'Show.S01E05.2160p.REMUX-GRP', size: 1000, releaseGroup: 'GRP', quality: { name: 'Remux-2160p' } })
    const sibling = release({ title: 'Show.S01E03.2160p.REMUX-GRP', size: 2000, releaseGroup: 'GRP', quality: { name: 'Remux-2160p' } })
    expect(releaseFilesMatch(queued, sibling)).toBe(false)
  })

  test('does not match a different release of the same item', () => {
    const queued = release({ title: 'Movie.2024.2160p.REMUX-GRP', size: 1000, releaseGroup: 'GRP', quality: { name: 'Remux-2160p' } })
    const onDisk = release({ title: 'Movie.2024.1080p.WEB-OTHER', size: 2000, releaseGroup: 'OTHER', quality: { name: 'WEBDL-1080p' } })
    expect(releaseFilesMatch(queued, onDisk)).toBe(false)
  })

  test('a zero-size queued release never matches purely on size', () => {
    const queued = release({ title: 'Foo', size: 0 })
    const onDisk = release({ title: 'Bar', size: 0 })
    expect(releaseFilesMatch(queued, onDisk)).toBe(false)
  })
})
