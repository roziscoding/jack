const API_KEY_PREFIX = 'jack_'

export function hashKey(key: string): string {
  return new Bun.CryptoHasher('sha256').update(key).digest('hex')
}

// Compare two secrets without leaking their contents through timing. Both sides
// are hashed to a fixed 32-byte digest first so the loop is length-independent
// (and a length mismatch can't short-circuit). Use this for any plaintext-secret
// comparison (master key, qBittorrent password); keys resolved by hash lookup in
// the DB don't need it.
export function constantTimeEqual(a: string, b: string): boolean {
  const da = new Bun.CryptoHasher('sha256').update(a).digest() as Uint8Array
  const db = new Bun.CryptoHasher('sha256').update(b).digest() as Uint8Array
  let diff = 0
  for (let i = 0; i < da.length; i++)
    diff |= da[i]! ^ db[i]!
  return diff === 0
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
