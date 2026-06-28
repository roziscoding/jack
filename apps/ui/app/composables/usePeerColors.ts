import type { InjectionKey, Ref } from 'vue'
import type { PeerColor } from '~/utils/peerColor'

const PEER_COLORS: InjectionKey<Ref<Map<string, PeerColor>>> = Symbol('peer-colors')

/** Provided by a container that knows the full peer set (e.g. the catalog page). */
export function providePeerColors(colors: Ref<Map<string, PeerColor>>): void {
  provide(PEER_COLORS, colors)
}

/**
 * Resolve a peer's accent classes from the provided color map, falling back to the
 * per-id hash when no map is in scope (so the components still work standalone).
 */
export function usePeerColors() {
  const colors = inject(PEER_COLORS, null)
  return {
    dotClass: (id: string) => colors?.value.get(id)?.dot ?? peerColorClass(id),
    textClass: (id: string) => colors?.value.get(id)?.text ?? peerColorTextClass(id),
  }
}
