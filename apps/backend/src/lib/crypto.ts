const API_KEY_PREFIX = 'jack_'

export function hashKey(key: string): string {
  return new Bun.CryptoHasher('sha256').update(key).digest('hex')
}

function randomHex(): string {
  const randomBytes = crypto.getRandomValues(new Uint8Array(32))
  return Array.from(randomBytes).map(b => b.toString(16).padStart(2, '0')).join('')
}

export function generateApiKey(): string {
  return `${API_KEY_PREFIX}${randomHex()}`
}

export function isGeneratedKey(key: string): boolean {
  // Exclude managed keys so isGeneratedKey/isManagedKey are mutually exclusive
  // regardless of evaluation order (managed keys share the `jack_` family).
  return key.startsWith(API_KEY_PREFIX) && !isManagedKey(key)
}

const MANAGED_KEY_PREFIX = 'jack_managed_'

export function generateManagedKey(): string {
  return `${MANAGED_KEY_PREFIX}${randomHex()}`
}

export function isManagedKey(key: string): boolean {
  return key.startsWith(MANAGED_KEY_PREFIX)
}

export { API_KEY_PREFIX, MANAGED_KEY_PREFIX }
