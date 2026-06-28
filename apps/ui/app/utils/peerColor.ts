// A stable accent color per peer, derived purely from the peer id so it stays the
// same across server restarts and clients with no persistence. The palette is Nuxt
// UI's primary colors minus black (too plain), indigo (Jack's own brand color), and
// green/emerald/rose/red (too close to the connection status green/red). Amber/yellow
// resemble the connecting status, but that only shows briefly and pulses, so it's fine.
// Each entry pairs the `bg-`/`text-` class as literals (so Tailwind's scanner emits
// them) and shares one index, so the filled dot and the icon color never drift.
// Ordered to step ~5 hues around the wheel rather than spectrally, so peers assigned
// consecutive slots get visibly different colors instead of neighboring shades.
const PEER_PALETTE = [
  { dot: 'bg-orange-500', text: 'text-orange-500' },
  { dot: 'bg-cyan-500', text: 'text-cyan-500' },
  { dot: 'bg-fuchsia-500', text: 'text-fuchsia-500' },
  { dot: 'bg-lime-500', text: 'text-lime-500' },
  { dot: 'bg-violet-500', text: 'text-violet-500' },
  { dot: 'bg-amber-500', text: 'text-amber-500' },
  { dot: 'bg-sky-500', text: 'text-sky-500' },
  { dot: 'bg-pink-500', text: 'text-pink-500' },
  { dot: 'bg-teal-500', text: 'text-teal-500' },
  { dot: 'bg-purple-500', text: 'text-purple-500' },
  { dot: 'bg-yellow-500', text: 'text-yellow-500' },
  { dot: 'bg-blue-500', text: 'text-blue-500' },
] as const

// FNV-1a: small, dependency-free, and well-distributed for short ids.
function hashId(id: string): number {
  let h = 2166136261
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

export interface PeerColor { dot: string, text: string }

function paletteFor(id: string): PeerColor {
  return PEER_PALETTE[hashId(id) % PEER_PALETTE.length]!
}

// Assign palette colors by each peer's position in the sorted, de-duplicated id set.
// This keeps colors distinct (up to the palette size) and identical across any view
// that shares the same peer set, instead of risking per-id hash collisions. Stable
// across restarts; a peer's color only shifts when the set of peers itself changes.
export function buildPeerColorMap(ids: Iterable<string>): Map<string, PeerColor> {
  const map = new Map<string, PeerColor>()
  const unique = [...new Set(ids)].sort()
  unique.forEach((id, i) => {
    map.set(id, PEER_PALETTE[i % PEER_PALETTE.length]!)
  })
  return map
}

/** Tailwind background class for a peer's filled accent dot, stable for a given id. */
export function peerColorClass(id: string): string {
  return paletteFor(id).dot
}

/** Tailwind text-color class for a peer's accent (e.g. a status icon), stable for a given id. */
export function peerColorTextClass(id: string): string {
  return paletteFor(id).text
}
