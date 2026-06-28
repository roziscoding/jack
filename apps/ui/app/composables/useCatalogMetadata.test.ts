import type { CatalogTitle, TmdbMetadata } from '~/types/management'
import { describe, expect, test } from 'bun:test'
import { useCatalogMetadata } from './useCatalogMetadata'

type StateRef<T> = { value: T }
type ManagementStub = { request: <T>(path: string) => Promise<T> }

type NuxtComposableGlobals = typeof globalThis & {
  useManagement: () => ManagementStub
  useState: <T>(key: string, init: () => T) => StateRef<T>
}

const globals = globalThis as NuxtComposableGlobals
const states = new Map<string, StateRef<unknown>>()

globals.useState = <T>(key: string, init: () => T): StateRef<T> => {
  const existing = states.get(key)
  if (existing) {
    // The test stub stores one stable state type per Nuxt key, matching useState's contract.
    return existing as StateRef<T>
  }
  const created = { value: init() } satisfies StateRef<T>
  states.set(key, created)
  return created
}

describe('useCatalogMetadata', () => {
  test('retries a metadata lookup after a transient error entry', async () => {
    states.clear()
    const metadata = {
      tmdbId: 603,
      title: 'The Matrix',
      overview: 'A hacker learns the truth.',
      year: 1999,
      rating: 8.2,
      posterUrl: 'https://image.tmdb.org/t/p/w500/poster.jpg',
      backdropUrl: null,
      genres: ['Action'],
    } satisfies TmdbMetadata
    const title = {
      key: 'movie:id:603',
      mediaType: 'movie',
      tmdbId: 603,
      displayTitle: 'The Matrix',
      releaseCount: 1,
      totalSize: 100,
      peers: [],
    } satisfies CatalogTitle
    let calls = 0
    globals.useManagement = () => ({
      request: async <T>() => {
        calls++
        if (calls === 1)
          throw new Error('tmdb unavailable')
        // load() asks for TmdbMetadata | null; the generic mirrors Nuxt's request helper.
        return metadata as T
      },
    })
    const { load, entryFor } = useCatalogMetadata()

    await load(title)
    await load(title)

    expect(calls).toBe(2)
    expect(entryFor(title)).toEqual({ status: 'loaded', data: metadata })
  })
})
