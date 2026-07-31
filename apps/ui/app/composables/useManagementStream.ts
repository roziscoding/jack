type SnapshotSubscriber = (snapshot: unknown) => void
type ConnectionSubscriber = (connected: boolean) => void
type AuthorizationCheck = () => Promise<void>

interface SharedManagementStream {
  source: EventSource
  connected: boolean
  snapshotSubscribers: Set<SnapshotSubscriber>
  connectionSubscribers: Set<ConnectionSubscriber>
}

const streams = new Map<string, SharedManagementStream>()
let authorizationCheck: Promise<void> | undefined

function verifyAuthorization(check: AuthorizationCheck) {
  authorizationCheck ??= check()
    .catch(() => {})
    .finally(() => authorizationCheck = undefined)
}

function openStream(path: string, checkAuthorization: AuthorizationCheck): SharedManagementStream {
  const existing = streams.get(path)
  if (existing)
    return existing

  const source = new EventSource(`/api/management/${path}`)
  const stream: SharedManagementStream = {
    source,
    connected: false,
    snapshotSubscribers: new Set(),
    connectionSubscribers: new Set(),
  }

  const setConnected = (connected: boolean) => {
    stream.connected = connected
    for (const subscriber of stream.connectionSubscribers)
      subscriber(connected)
  }

  source.onopen = () => setConnected(true)
  source.onmessage = (event) => {
    let snapshot: unknown
    try {
      snapshot = JSON.parse(event.data) as unknown
    }
    catch {
      return
    }
    for (const subscriber of stream.snapshotSubscribers) {
      try {
        subscriber(snapshot)
      }
      catch {
        // One component must not prevent the others from receiving this frame.
      }
    }
  }
  source.onerror = () => {
    setConnected(false)
    verifyAuthorization(checkAuthorization)
  }
  streams.set(path, stream)
  return stream
}

/** Share one management SSE connection per path while components are subscribed. */
export function useManagementStream<T>(path: string, onSnapshot: (snapshot: T) => void) {
  const { request } = useManagement()
  const connected = ref(false)
  let stream: SharedManagementStream | undefined
  const snapshotSubscriber: SnapshotSubscriber = snapshot => onSnapshot(snapshot as T)
  const connectionSubscriber: ConnectionSubscriber = value => connected.value = value

  onMounted(() => {
    stream = openStream(path, async () => {
      await request('ping')
    })
    stream.snapshotSubscribers.add(snapshotSubscriber)
    stream.connectionSubscribers.add(connectionSubscriber)
    connected.value = stream.connected
  })

  onUnmounted(() => {
    if (!stream)
      return
    stream.snapshotSubscribers.delete(snapshotSubscriber)
    stream.connectionSubscribers.delete(connectionSubscriber)
    if (stream.snapshotSubscribers.size === 0) {
      stream.source.close()
      streams.delete(path)
    }
    stream = undefined
    connected.value = false
  })

  return { connected }
}
