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

export function formatDate(iso: string | null | undefined): string {
  if (!iso)
    return '—'
  const date = new Date(iso)
  if (Number.isNaN(date.getTime()))
    return iso
  return date.toLocaleString()
}
