import { describe, expect, test } from 'bun:test'
import { Envs } from '../lib/envs'

describe('management key environment variables', () => {
  test('accepts JACK_MANAGEMENT_KEY', () => {
    const envs = Envs.parse({ JACK_MANAGEMENT_KEY: 'prefixed-key' })

    expect(envs.MANAGEMENT_KEY).toBe('prefixed-key')
  })

  test('accepts MANAGEMENT_KEY', () => {
    const envs = Envs.parse({ MANAGEMENT_KEY: 'legacy-key' })

    expect(envs.MANAGEMENT_KEY).toBe('legacy-key')
  })

  test('omits MANAGEMENT_KEY when neither name is set', () => {
    const envs = Envs.parse({})

    expect(envs).not.toHaveProperty('MANAGEMENT_KEY')
  })

  test('ignores an invalid legacy value when JACK_MANAGEMENT_KEY is set', () => {
    const envs = Envs.parse({
      JACK_MANAGEMENT_KEY: 'prefixed-key',
      MANAGEMENT_KEY: '',
    })

    expect(envs.MANAGEMENT_KEY).toBe('prefixed-key')
  })

  test('prefers JACK_MANAGEMENT_KEY when both are set', () => {
    const envs = Envs.parse({
      JACK_MANAGEMENT_KEY: 'prefixed-key',
      MANAGEMENT_KEY: 'legacy-key',
    })

    expect(envs.MANAGEMENT_KEY).toBe('prefixed-key')
  })
})
