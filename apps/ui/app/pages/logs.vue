<script setup lang="ts">
import type { BadgeProps } from '@nuxt/ui'
import type { LogRecord } from '~/types/management'

type Row = LogRecord & { _id: number }

const { request, extractError } = useManagement()

// 'all' means no server-side level floor; the rest map to the pino level names.
const LEVELS = ['all', 'trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const
type LevelFilter = typeof LEVELS[number]
const level = ref<LevelFilter>('all')
const levelItems = LEVELS.map(value => ({ label: value === 'all' ? 'All levels' : value.toUpperCase(), value }))

// How many lines to backfill on load, and the in-memory cap for the live view.
const BACKFILL_LINES = 500
const MAX_ROWS = 2000

const rows = ref<Row[]>([])
const pending = ref(false)
const error = ref('')
const live = ref(true)
const connected = ref(false)

let seq = 0
let source: EventSource | null = null

function tag(record: LogRecord): Row {
  return { ...record, _id: seq++ }
}

function levelQuery(prefix: '?' | '&'): string {
  return level.value === 'all' ? '' : `${prefix}level=${level.value}`
}

async function loadBackfill() {
  pending.value = true
  error.value = ''
  try {
    const res = await request<{ logs: LogRecord[] }>(`logs?lines=${BACKFILL_LINES}${levelQuery('&')}`)
    rows.value = res.logs.map(tag)
    scheduleScroll(true)
  }
  catch (err) {
    error.value = extractError(err, 'Failed to load logs.')
  }
  finally {
    pending.value = false
  }
}

function append(record: LogRecord) {
  rows.value.push(tag(record))
  if (rows.value.length > MAX_ROWS)
    rows.value.splice(0, rows.value.length - MAX_ROWS)
  scheduleScroll(false)
}

function disconnect() {
  source?.close()
  source = null
  connected.value = false
}

function connect() {
  if (!import.meta.client)
    return
  disconnect()
  source = new EventSource(`/api/management/logs/stream${levelQuery('?')}`)
  source.onopen = () => {
    connected.value = true
  }
  source.onmessage = (event) => {
    if (!event.data)
      return
    try {
      append(JSON.parse(event.data) as LogRecord)
    }
    catch {
      // Ignore a malformed frame rather than break the stream.
    }
  }
  source.onerror = () => {
    // EventSource reconnects on its own; just reflect the gap in the UI.
    connected.value = false
  }
}

async function reload() {
  await loadBackfill()
  if (live.value)
    connect()
}

function toggleLive() {
  live.value = !live.value
  if (live.value)
    connect()
  else
    disconnect()
}

function clear() {
  rows.value = []
}

watch(level, reload)
onMounted(reload)
onBeforeUnmount(disconnect)

// --- Auto-scroll: stick to the bottom unless the user has scrolled up. ---
const scroller = useTemplateRef<HTMLElement>('scroller')
const stick = ref(true)

function onScroll() {
  const el = scroller.value
  if (el)
    stick.value = el.scrollHeight - el.scrollTop - el.clientHeight < 48
}

function scheduleScroll(force: boolean) {
  if (!force && !stick.value)
    return
  nextTick(() => {
    const el = scroller.value
    if (el)
      el.scrollTop = el.scrollHeight
  })
}

// --- Per-row display helpers. ---
const RESERVED = new Set(['time', 'level', 'severity', 'message', 'pid', 'hostname', 'msg'])

function levelName(record: LogRecord): string {
  if (record.severity)
    return record.severity
  const level = record.level ?? 30
  return level >= 60 ? 'fatal' : level >= 50 ? 'error' : level >= 40 ? 'warn' : level >= 30 ? 'info' : level >= 20 ? 'debug' : 'trace'
}

function levelColor(name: string): BadgeProps['color'] {
  if (name === 'warn')
    return 'warning'
  if (name === 'error' || name === 'fatal')
    return 'error'
  if (name === 'info')
    return 'info'
  return 'neutral'
}

function clockTime(record: LogRecord): string {
  if (typeof record.time !== 'number')
    return ''
  const date = new Date(record.time)
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleTimeString()
}

function detail(record: Row): string {
  const extra: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(record)) {
    if (key === '_id' || RESERVED.has(key))
      continue
    extra[key] = value
  }
  return JSON.stringify(extra, null, 2)
}

function hasDetail(record: Row): boolean {
  return detail(record) !== '{}'
}

const expanded = ref<Set<number>>(new Set())
function toggle(id: number) {
  const next = new Set(expanded.value)
  if (next.has(id))
    next.delete(id)
  else
    next.add(id)
  expanded.value = next
}
</script>

<template>
  <UDashboardPanel id="logs">
    <template #header>
      <UDashboardNavbar title="Logs">
        <template #right>
          <div class="flex items-center gap-2">
            <UBadge
              :color="live ? (connected ? 'success' : 'warning') : 'neutral'"
              variant="subtle"
              :icon="live ? 'i-ph-broadcast' : 'i-ph-pause'"
            >
              {{ live ? (connected ? 'Live' : 'Reconnecting…') : 'Paused' }}
            </UBadge>
            <USelect v-model="level" :items="levelItems" size="sm" class="w-36" aria-label="Minimum log level" />
            <UButton
              :icon="live ? 'i-ph-pause' : 'i-ph-play'"
              :label="live ? 'Pause' : 'Resume'"
              color="neutral"
              variant="ghost"
              size="sm"
              @click="toggleLive"
            />
            <UButton icon="i-ph-trash" label="Clear" color="neutral" variant="ghost" size="sm" @click="clear" />
          </div>
        </template>
      </UDashboardNavbar>
    </template>

    <template #body>
      <UAlert v-if="error" color="error" variant="soft" icon="i-ph-warning" :title="error" />

      <p v-else-if="pending && rows.length === 0" class="flex items-center gap-2 text-sm text-muted">
        <UIcon name="i-ph-circle-notch" class="size-4 animate-spin" />
        Loading…
      </p>

      <UCard v-else-if="rows.length === 0" variant="subtle">
        <div class="flex flex-col items-center gap-3 py-6 text-center">
          <UIcon name="i-ph-scroll" class="size-8 text-dimmed" />
          <p class="text-sm text-muted">
            No log lines yet. New entries stream in here as the server logs them.
          </p>
        </div>
      </UCard>

      <div
        v-else
        ref="scroller"
        class="h-full overflow-auto rounded-lg border border-default bg-elevated/40 font-mono text-xs"
        @scroll="onScroll"
      >
        <div
          v-for="row in rows"
          :key="row._id"
          class="border-b border-default/50 last:border-b-0"
        >
          <button
            type="button"
            class="flex w-full items-start gap-2 px-3 py-1 text-left hover:bg-elevated"
            @click="toggle(row._id)"
          >
            <span class="shrink-0 tabular-nums text-dimmed">{{ clockTime(row) }}</span>
            <UBadge :color="levelColor(levelName(row))" variant="subtle" size="sm" class="shrink-0 uppercase">
              {{ levelName(row) }}
            </UBadge>
            <span class="min-w-0 flex-1 break-words whitespace-pre-wrap text-default">{{ row.message }}</span>
            <UIcon
              v-if="hasDetail(row)"
              :name="expanded.has(row._id) ? 'i-ph-caret-up' : 'i-ph-caret-down'"
              class="mt-0.5 size-3.5 shrink-0 text-dimmed"
            />
          </button>
          <pre
            v-if="expanded.has(row._id) && hasDetail(row)"
            class="overflow-x-auto border-t border-default/50 bg-default/50 px-3 py-2 text-muted"
          >{{ detail(row) }}</pre>
        </div>
      </div>
    </template>
  </UDashboardPanel>
</template>
