export function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null || Number.isNaN(bytes))
    return '—'
  if (bytes === 0)
    return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  const value = bytes / 1024 ** exponent
  return `${value.toFixed(value >= 100 || exponent === 0 ? 0 : 1)} ${units[exponent]}`
}

export function formatPercent(fraction: number | null | undefined): string {
  if (fraction == null)
    return '—'
  return `${Math.round(fraction * 100)}%`
}

// Short, compact "time since" for at-a-glance dashboard rows (e.g. "14m", "2h",
// "3d"). Not meant to be precise — pairs with a full timestamp in a `title`.
export function formatAgo(iso: string | null | undefined): string {
  if (!iso)
    return ''
  const then = new Date(iso).getTime()
  if (Number.isNaN(then))
    return ''
  const seconds = Math.max(0, Math.floor((Date.now() - then) / 1000))
  if (seconds < 60)
    return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60)
    return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24)
    return `${hours}h`
  return `${Math.floor(hours / 24)}d`
}

// Reads a millisecond config value back in human terms ("1800000" → "30 min").
// Settings surfaces the raw ms — that's what the config file holds — and pairs it
// with this so the number means something at a glance.
export function formatDurationMs(ms: number | null | undefined): string {
  if (ms == null || Number.isNaN(ms))
    return ''
  if (ms === 0)
    return 'no delay'
  // Round first, then drop a trailing ".0" — otherwise 59_999 ms reads "60.0 s".
  const trim = (n: number) => {
    const rounded = Math.round(n * 10) / 10
    return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1)
  }
  if (ms < 1000)
    return `${ms} ms`
  if (ms < 60_000)
    return `${trim(ms / 1000)} s`
  if (ms < 3_600_000)
    return `${trim(ms / 60_000)} min`
  return `${trim(ms / 3_600_000)} h`
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso)
    return '—'
  const date = new Date(iso)
  if (Number.isNaN(date.getTime()))
    return iso
  return date.toLocaleString()
}
