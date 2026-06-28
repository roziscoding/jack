import type { MaybeRefOrGetter } from 'vue'

export interface PollingOptions {
  /** Tick interval in ms. Reactive — changing it restarts the timer. Default 5000. */
  intervalMs?: MaybeRefOrGetter<number>
  /** Only tick while this is true. Reactive — flipping it starts/stops the timer. Default true. */
  enabled?: MaybeRefOrGetter<boolean>
  /** Skip a tick while the tab is hidden (no point refetching unseen data). Default true. */
  whenVisible?: boolean
}

/**
 * Run `callback` on an interval while enabled, skipping ticks when the tab is hidden.
 * Client-only, reactive to `enabled`/`intervalMs`, and self-cleaning via `onScopeDispose`
 * — so it works both inside a component (stops on unmount) and inside a detached
 * `effectScope` (stops when that scope is disposed).
 */
export function usePolling(callback: () => void | Promise<void>, options: PollingOptions = {}) {
  const { whenVisible = true } = options
  let timer: ReturnType<typeof setInterval> | undefined

  function stop() {
    if (timer) {
      clearInterval(timer)
      timer = undefined
    }
  }

  if (import.meta.client) {
    watch(
      () => [toValue(options.enabled ?? true), toValue(options.intervalMs ?? 5000)] as const,
      ([enabled, ms]) => {
        stop()
        if (enabled) {
          timer = setInterval(() => {
            if (whenVisible && document.hidden)
              return
            void callback()
          }, ms)
        }
      },
      { immediate: true },
    )
    onScopeDispose(stop)
  }

  return { stop }
}
