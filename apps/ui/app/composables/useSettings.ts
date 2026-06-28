import type { Ref } from 'vue'
import type { PeerItem, ServerItem } from '~/types/management'
import type { PeerColor } from '~/utils/peerColor'

export interface SettingsState {
  peers: PeerItem[]
  servers: ServerItem[]
  // Distinct, view-consistent colors derived once from the full peer set so callers
  // don't recompute them on every render. See buildPeerColorMap.
  peerColors: Map<string, PeerColor>
}

// How often to re-poll config while a connector is still settling.
const POLL_MS = 5000

let pollingStarted = false

/**
 * Poll the config endpoints only while a change is expected — i.e. some connector is
 * still connecting or is down (and might recover). Once everything is connected there's
 * nothing to wait on, so polling stops until the next transition. Set up once at module
 * scope (detached effectScope) so a single poller runs no matter how many components use
 * the store, independent of any one component's lifecycle.
 */
function startAdaptivePolling(settings: Ref<SettingsState | null>, reload: () => Promise<void>) {
  if (pollingStarted || !import.meta.client)
    return
  pollingStarted = true

  effectScope(true).run(() => {
    const transitioning = computed(() => {
      const s = settings.value
      if (!s)
        return false
      return s.peers.some(p => !p.initialized) || s.servers.some(srv => !srv.initialized)
    })
    usePolling(reload, { intervalMs: POLL_MS, enabled: transitioning })
  })
}

/**
 * Shared connector settings (peers + servers) and their derived peer colors. Backed by
 * a single `useState` so every view reads the same data and the config endpoints are
 * fetched once per session. Loads lazily on first use (when the state is still null);
 * call `reload()` to refetch after a mutation. While any connector is connecting or
 * down, the store self-polls so a completed handshake/recovery shows without a refresh.
 */
export function useSettings() {
  const { request } = useManagement()
  const settings = useState<SettingsState | null>('settings', () => null)
  const pending = useState('settings:pending', () => false)
  const error = useState<unknown>('settings:error', () => null)

  async function reload() {
    pending.value = true
    error.value = null
    try {
      const [peersRes, serversRes] = await Promise.all([
        request<{ peers: PeerItem[] }>('config/peers'),
        request<{ servers: ServerItem[] }>('config/servers'),
      ])
      settings.value = {
        peers: peersRes.peers,
        servers: serversRes.servers,
        peerColors: buildPeerColorMap(peersRes.peers.map(p => p.id)),
      }
    }
    catch (err) {
      error.value = err
    }
    finally {
      pending.value = false
    }
  }

  // Load on first usage. `reload` flips `pending` synchronously before its first await,
  // so concurrent callers in the same tick won't each kick off a fetch.
  if (settings.value === null && !pending.value)
    reload()

  startAdaptivePolling(settings, reload)

  return { settings, pending, error, reload }
}
