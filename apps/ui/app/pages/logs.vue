<script setup lang="ts">
import type { GroupedRow } from '~/components/LogRow.vue'
import type { LogRecord } from '~/types/management'
import { extractHttp, groupKey, levelName } from '~/utils/logFormat'

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

// View controls.
const query = ref('')
const collapse = ref(true)

let seq = 0
let source: EventSource | null = null

function tag(record: LogRecord): Row {
  return { ...record, _id: seq++ }
}

function levelQuery(prefix: '?' | '&'): string {
  return level.value === 'all' ? '' : `${prefix}level=${level.value}`
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
  // Capture this stream so a callback queued from a superseded EventSource (a
  // fast level change reconnects mid-dispatch) can't append a previous-filter
  // record or flip `connected` after `source` has moved on.
  const nextSource = new EventSource(`/api/management/logs/stream${levelQuery('?')}`)
  source = nextSource
  nextSource.onopen = () => {
    if (source === nextSource)
      connected.value = true
  }
  nextSource.onmessage = (event) => {
    if (source !== nextSource || !event.data)
      return
    try {
      append(JSON.parse(event.data) as LogRecord)
    }
    catch {
      // Ignore a malformed frame rather than break the stream.
    }
  }
  nextSource.onerror = () => {
    // EventSource reconnects on its own; just reflect the gap in the UI.
    if (source === nextSource)
      connected.value = false
  }
}

// Guards overlapping reloads (fast level changes): each reload takes a ticket and
// only the newest may replace `rows`, clear `pending`, or reconnect — so a slower
// earlier backfill can't resolve late and win with stale, wrong-filter rows.
let reloadSeq = 0

async function reload() {
  const seq = ++reloadSeq
  // Close the old stream first so it can't append previous-filter lines during
  // the backfill request.
  disconnect()
  pending.value = true
  error.value = ''
  try {
    const res = await request<{ logs: LogRecord[] }>(`logs?lines=${BACKFILL_LINES}${levelQuery('&')}`)
    if (seq !== reloadSeq)
      return
    rows.value = res.logs.map(tag)
    scheduleScroll(true)
  }
  catch (err) {
    if (seq !== reloadSeq)
      return
    error.value = extractError(err, 'Failed to load logs.')
  }
  finally {
    if (seq === reloadSeq)
      pending.value = false
  }
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

// --- Text filter over the raw stream (path, message, method, status, level). ---
function haystack(row: Row): string {
  const http = extractHttp(row)
  return [
    row.message,
    levelName(row),
    http?.method,
    http?.path,
    http?.status,
  ].filter(v => v != null).join(' ').toLowerCase()
}

const filtered = computed(() => {
  const q = query.value.trim().toLowerCase()
  if (!q)
    return rows.value
  return rows.value.filter(row => haystack(row).includes(q))
})

// --- Fold consecutive identical lines into one row with a ×N counter. ---
function durationOf(row: Row): number | undefined {
  return typeof row.durationMs === 'number' ? row.durationMs : undefined
}

const groups = computed<GroupedRow[]>(() => {
  const list = filtered.value
  if (!collapse.value)
    return list.map(r => ({ ...r, _count: 1, _durations: durationOf(r) !== undefined ? [durationOf(r)!] : [] }))

  const out: GroupedRow[] = []
  let prevKey: string | null = null
  for (const r of list) {
    const key = groupKey(r)
    const dur = durationOf(r)
    const last = out.at(-1)
    if (last && key === prevKey) {
      // Refresh to the latest occurrence but keep the run's first id as a stable
      // key so an expanded row doesn't collapse as identical lines stream in.
      const id = last._id
      const durations = last._durations
      if (dur !== undefined)
        durations.push(dur)
      Object.assign(last, r, { _id: id, _count: last._count + 1, _durations: durations })
    }
    else {
      out.push({ ...r, _count: 1, _durations: dur !== undefined ? [dur] : [] })
      prevKey = key
    }
  }
  return out
})

const expanded = ref<Set<number>>(new Set())
function toggle(id: number) {
  const next = new Set(expanded.value)
  if (next.has(id))
    next.delete(id)
  else
    next.add(id)
  expanded.value = next
}

const summary = computed(() => {
  const total = rows.value.length
  const shown = groups.value.length
  if (query.value.trim())
    return `${filtered.value.length} of ${total} lines`
  if (collapse.value && shown !== total)
    return `${shown} rows · ${total} lines`
  return `${total} lines`
})
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
            <USelect v-model="level" :items="levelItems" size="sm" class="w-32" aria-label="Minimum log level" />
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
      <div class="flex h-full flex-col gap-3">
        <!-- Filter bar -->
        <div class="flex flex-wrap items-center gap-x-3 gap-y-2">
          <UInput
            v-model="query"
            icon="i-ph-magnifying-glass"
            placeholder="Filter by path, method, status or message"
            size="sm"
            class="min-w-56 flex-1"
            :ui="{ trailing: 'pe-1' }"
          >
            <template v-if="query" #trailing>
              <UButton
                icon="i-ph-x"
                color="neutral"
                variant="link"
                size="xs"
                aria-label="Clear filter"
                @click="() => { query = '' }"
              />
            </template>
          </UInput>
          <USwitch v-model="collapse" label="Collapse repeats" size="sm" />
          <span class="ms-auto shrink-0 text-xs tabular-nums text-dimmed">{{ summary }}</span>
        </div>

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
          v-else-if="groups.length === 0"
          class="flex flex-col items-center gap-2 rounded-lg border border-dashed border-default py-10 text-center"
        >
          <UIcon name="i-ph-magnifying-glass" class="size-6 text-dimmed" />
          <p class="text-sm text-muted">
            No lines match “{{ query }}”.
          </p>
        </div>

        <div
          v-else
          ref="scroller"
          class="min-h-0 flex-1 overflow-auto rounded-lg border border-default bg-elevated/40 font-mono text-xs"
          @scroll="onScroll"
        >
          <LogRow
            v-for="row in groups"
            :key="row._id"
            :row="row"
            :expanded="expanded.has(row._id)"
            class="border-b border-default/40 last:border-b-0"
            @toggle="toggle(row._id)"
          />
        </div>
      </div>
    </template>
  </UDashboardPanel>
</template>
