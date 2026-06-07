// jack's own version, reported to peers over /handshake. This doubles as the
// peer-protocol version: a bump here signals a potential protocol change.
export const PROTOCOL_VERSION = '0.1.0'

// Oldest peer version we can still talk to. Peers below this — or peers too old
// to expose a version at all — are rejected at init time as incompatible.
export const MIN_PEER_PROTOCOL_VERSION = '0.1.0'

const VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)$/

function parseVersion(version: string): [number, number, number] | null {
  const match = VERSION_PATTERN.exec(version.trim())
  if (!match)
    return null
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

/**
 * Compare two `x.y.z` versions numerically by major, then minor, then patch.
 * Returns -1 if `a < b`, 0 if equal, 1 if `a > b`. Throws on malformed input.
 */
export function compareVersions(a: string, b: string): -1 | 0 | 1 {
  const parsedA = parseVersion(a)
  const parsedB = parseVersion(b)
  if (!parsedA)
    throw new Error(`Invalid version string: "${a}"`)
  if (!parsedB)
    throw new Error(`Invalid version string: "${b}"`)
  for (let i = 0; i < 3; i++) {
    if (parsedA[i]! < parsedB[i]!)
      return -1
    if (parsedA[i]! > parsedB[i]!)
      return 1
  }
  return 0
}

/**
 * Whether a peer's reported version is new enough to talk to (>= the minimum we
 * support). A malformed or empty version is treated as incompatible.
 */
export function isPeerVersionCompatible(version: string): boolean {
  if (!parseVersion(version))
    return false
  return compareVersions(version, MIN_PEER_PROTOCOL_VERSION) >= 0
}
