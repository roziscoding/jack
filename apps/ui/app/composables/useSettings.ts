import type { PeerItem, ServerItem } from '~/types/management'
import type { PeerColor } from '~/utils/peerColor'

export interface SettingsState {
  peers: PeerItem[]
  servers: ServerItem[]
  // Distinct, view-consistent colors derived once from the full peer set so callers
  // don't recompute them on every render. See buildPeerColorMap.
  peerColors: Map<string, PeerColor>
}

let settingsRevision = 0

function toSettingsState(peers: PeerItem[], servers: ServerItem[]): SettingsState {
  return {
    peers,
    servers,
    peerColors: buildPeerColorMap(peers.map(peer => peer.id)),
  }
}

/**
 * Shared connector settings (peers + servers) and their derived peer colors. Backed by
 * a single `useState` so every view reads the same data and the config endpoints are
 * initialized and updated through one shared SSE connection while settings consumers
 * are mounted. Call `reload()` to refetch explicitly after a mutation when needed.
 */
export function useSettings() {
  const { request } = useManagement()
  const auth = useAuthState()
  const settings = useState<SettingsState | null>('settings', () => null)
  const pending = useState('settings:pending', () => false)
  const error = useState<unknown>('settings:error', () => null)

  async function reload() {
    const revision = settingsRevision
    pending.value = true
    error.value = null
    try {
      const [peersRes, serversRes] = await Promise.all([
        request<{ peers: PeerItem[] }>('config/peers'),
        request<{ servers: ServerItem[] }>('config/servers'),
      ])
      if (revision === settingsRevision)
        settings.value = toSettingsState(peersRes.peers, serversRes.servers)
    }
    catch (err) {
      error.value = err
    }
    finally {
      pending.value = false
    }
  }

  useManagementStream<{ peers: PeerItem[], servers: ServerItem[] }>('config/stream', (snapshot) => {
    settingsRevision++
    settings.value = toSettingsState(snapshot.peers, snapshot.servers)
  })
  watch(() => auth.value.status, (status) => {
    if (status !== 'ok') {
      settingsRevision++
      settings.value = null
    }
  })

  return { settings, pending, error, reload }
}
