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

export function formatDate(iso: string | null | undefined): string {
  if (!iso)
    return '—'
  const date = new Date(iso)
  if (Number.isNaN(date.getTime()))
    return iso
  return date.toLocaleString()
}
