import { describe, expect, test } from 'bun:test'
import { formatDurationMs } from './format'

// Settings shows raw milliseconds (that's what the config file holds) next to this
// reading of them, so the numbers stay editable without being unreadable.
describe('formatDurationMs', () => {
  test('reads the config defaults back in human terms', () => {
    expect(formatDurationMs(1000)).toBe('1 s')
    expect(formatDurationMs(30_000)).toBe('30 s')
    expect(formatDurationMs(60_000)).toBe('1 min')
    expect(formatDurationMs(1_800_000)).toBe('30 min')
  })

  test('keeps sub-second values in milliseconds', () => {
    expect(formatDurationMs(250)).toBe('250 ms')
    expect(formatDurationMs(999)).toBe('999 ms')
  })

  test('switches unit at each boundary', () => {
    expect(formatDurationMs(59_999)).toBe('60 s')
    expect(formatDurationMs(3_599_999)).toBe('60 min')
    expect(formatDurationMs(3_600_000)).toBe('1 h')
    expect(formatDurationMs(7_200_000)).toBe('2 h')
  })

  test('shows one decimal for values between units', () => {
    expect(formatDurationMs(1500)).toBe('1.5 s')
    expect(formatDurationMs(90_000)).toBe('1.5 min')
  })

  test('names zero rather than printing "0 ms"', () => {
    expect(formatDurationMs(0)).toBe('no delay')
  })

  test('returns nothing when there is no value to read', () => {
    expect(formatDurationMs(null)).toBe('')
    expect(formatDurationMs(undefined)).toBe('')
    expect(formatDurationMs(Number.NaN)).toBe('')
  })
})
