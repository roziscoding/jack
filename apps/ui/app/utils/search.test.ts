import { describe, expect, test } from 'bun:test'
import { matchesSearch, normalizeForSearch } from './search'

const FILE = 'Big.Buck.Bunny.2024.2160p.WEB-DL.HEVC.mkv'

describe('normalizeForSearch', () => {
  test('turns release-name punctuation into spaces', () => {
    expect(normalizeForSearch(FILE)).toBe('big buck bunny 2024 2160p web dl hevc mkv')
  })

  test('strips accents', () => {
    expect(normalizeForSearch('Amélie_(2001)')).toBe('amelie 2001')
  })
})

describe('matchesSearch', () => {
  test('matches words typed with spaces against a dotted release name', () => {
    expect(matchesSearch(FILE, 'big buck')).toBe(true)
    expect(matchesSearch(FILE, 'Big Buck Bunny')).toBe(true)
  })

  test('matches words in any order and partial words', () => {
    expect(matchesSearch(FILE, 'bunny 2160')).toBe(true)
    expect(matchesSearch(FILE, 'web-dl buck')).toBe(true)
  })

  test('needs every word to match', () => {
    expect(matchesSearch(FILE, 'big sintel')).toBe(false)
  })

  test('an empty or punctuation-only query matches everything', () => {
    expect(matchesSearch(FILE, '')).toBe(true)
    expect(matchesSearch(FILE, ' .. ')).toBe(true)
  })
})
