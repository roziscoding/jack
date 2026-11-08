import type { DownloadsRepository } from './downloads.repository'

// Speed is averaged over this much recent history.
const SPEED_WINDOW_MS = 10_000
// Live updates fire at most this often, so the SSE stream (a full snapshot per
// notify) stays at about one frame per second however many transfers run.
const NOTIFY_INTERVAL_MS = 1000

export interface LiveProgress {
  downloadedBytes: number
  /** Bytes per second over the recent window, or null until two samples exist. */
  speedBps: number | null
}

/**
 * In-memory byte counts for running transfers, fed about once a second by the
 * peer download loop. The database only stores progress every 10 s / 64 MiB
 * (each write also fsyncs the .part), so this is what lets the UI move the bar
 * and show a speed in between. Nothing here is persisted.
 */
export class LiveProgressTracker {
  private readonly samples = new Map<number, { t: number, bytes: number }[]>()
  private readonly subscribers = new Set<() => void>()
  private notifyTimer?: ReturnType<typeof setTimeout>

  constructor(private readonly now: () => number = Date.now) {}

  record(id: number, bytes: number): void {
    const t = this.now()
    const kept = (this.samples.get(id) ?? []).filter(s => t - s.t <= SPEED_WINDOW_MS)
    // Fewer bytes than before means the transfer started over (restart or retry).
    const window = kept.length > 0 && bytes < kept.at(-1)!.bytes
      ? []
      : kept
    window.push({ t, bytes })
    this.samples.set(id, window)
    this.scheduleNotify()
  }

  clear(id: number): void {
    if (this.samples.delete(id))
      this.scheduleNotify()
  }

  get(id: number): LiveProgress | null {
    const window = this.samples.get(id)
    if (!window?.length)
      return null
    const first = window[0]!
    const last = window.at(-1)!
    const elapsedMs = last.t - first.t
    return {
      downloadedBytes: last.bytes,
      speedBps: elapsedMs > 0
        ? ((last.bytes - first.bytes) * 1000) / elapsedMs
        : null,
    }
  }

  subscribe(subscriber: () => void): () => void {
    this.subscribers.add(subscriber)
    return () => this.subscribers.delete(subscriber)
  }

  private scheduleNotify(): void {
    if (this.notifyTimer)
      return
    this.notifyTimer = setTimeout(() => {
      this.notifyTimer = undefined
      for (const subscriber of this.subscribers) {
        try {
          subscriber()
        }
        catch {
          // A broken observer must not stop the transfer that fed it.
        }
      }
    }, NOTIFY_INTERVAL_MS)
  }
}

const trackers = new WeakMap<DownloadsRepository, LiveProgressTracker>()

/** One tracker per repository, shared by the service (writer) and status API (reader). */
export function liveProgressFor(repository: DownloadsRepository): LiveProgressTracker {
  let tracker = trackers.get(repository)
  if (!tracker) {
    tracker = new LiveProgressTracker()
    trackers.set(repository, tracker)
  }
  return tracker
}
