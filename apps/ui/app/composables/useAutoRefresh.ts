export interface RefreshOption {
  label: string
  ms: number
}

export const REFRESH_OPTIONS: RefreshOption[] = [
  { label: '2s', ms: 2000 },
  { label: '5s', ms: 5000 },
  { label: '10s', ms: 10_000 },
  { label: '30s', ms: 30_000 },
  { label: '1m', ms: 60_000 },
]

/**
 * Drives a periodic refresh with a live countdown and a pause toggle. A single 1s
 * ticker advances the countdown and fires `refresh` when it reaches zero; resuming
 * refreshes immediately so you're never left staring at stale data.
 */
export function useAutoRefresh(refresh: () => unknown | Promise<unknown>, defaultMs = 5000) {
  const intervalMs = ref(defaultMs)
  const paused = ref(false)
  const secondsLeft = ref(Math.ceil(intervalMs.value / 1000))

  function resetCountdown() {
    secondsLeft.value = Math.ceil(intervalMs.value / 1000)
  }

  async function refreshNow() {
    resetCountdown()
    await refresh()
  }

  function togglePaused() {
    paused.value = !paused.value
    if (!paused.value)
      void refreshNow()
  }

  // Picking a new interval refreshes right away — switching to a faster cadence
  // means "show me fresher data now", mirroring resume-from-pause.
  watch(intervalMs, () => void refreshNow())

  // A single 1s ticker drives the countdown and fires the refresh at zero. whenVisible
  // is off so the countdown keeps running in a background tab, as it always has.
  usePolling(() => {
    if (paused.value)
      return
    secondsLeft.value -= 1
    if (secondsLeft.value <= 0) {
      resetCountdown()
      void refresh()
    }
  }, { intervalMs: 1000, whenVisible: false })

  return { REFRESH_OPTIONS, intervalMs, paused, secondsLeft, refreshNow, togglePaused }
}
