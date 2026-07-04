<script setup lang="ts">
import type { LogRecord } from '~/types/management'
import {
  clockTime,
  extractHttp,
  extraFields,
  formatMs,
  latencyBarClass,
  latencyClass,
  latencyFill,
  levelStyle,
  methodClass,
  rawJson,
  statusClass,
} from '~/utils/logFormat'

// A grouped row: a representative record plus how many consecutive identical
// lines it folds (`_count`) and each occurrence's duration (`_durations`).
export type GroupedRow = LogRecord & { _id: number, _count: number, _durations: number[] }

const props = defineProps<{ row: GroupedRow, expanded: boolean }>()
const emit = defineEmits<{ toggle: [] }>()

const toast = useToast()

const level = computed(() => levelStyle(props.row))
const http = computed(() => extractHttp(props.row))
const time = computed(() => clockTime(props.row.time))
const count = computed(() => props.row._count)

// The live row shows the latest occurrence's latency; the detail panel carries
// the spread across the folded group.
const lastMs = computed(() => {
  const d = props.row._durations
  return d.length ? d.at(-1)! : undefined
})
const latStats = computed(() => {
  const d = props.row._durations.filter(n => Number.isFinite(n))
  if (d.length < 2)
    return null
  return {
    max: Math.max(...d),
    avg: d.reduce((a, b) => a + b, 0) / d.length,
  }
})

const fields = computed(() => extraFields(props.row))
const showRaw = ref(false)
function toggleRaw() {
  showRaw.value = !showRaw.value
}

async function copyRaw() {
  try {
    await navigator.clipboard.writeText(rawJson(props.row))
    toast.add({ title: 'Copied', description: 'Log record copied to clipboard.', color: 'success', icon: 'i-ph-check-circle' })
  }
  catch {
    toast.add({ title: 'Copy failed', description: 'Clipboard is unavailable in this context.', color: 'error', icon: 'i-ph-warning' })
  }
}
</script>

<template>
  <div class="border-l-2" :class="level.rail">
    <button
      type="button"
      class="flex w-full items-center gap-3 py-1 pl-2.5 pr-3 text-left hover:bg-elevated"
      @click="emit('toggle')"
    >
      <!-- Timestamp -->
      <time class="w-[6.5rem] shrink-0 tabular-nums text-dimmed">{{ time }}</time>

      <!-- Severity -->
      <span class="w-12 shrink-0 font-medium tracking-tight" :class="level.text">{{ level.label }}</span>

      <!-- Content: a request line, or the plain message -->
      <span v-if="http" class="flex min-w-0 flex-1 items-center gap-2">
        <span class="w-14 shrink-0 font-semibold" :class="methodClass(http.method)">{{ http.method }}</span>
        <span class="truncate text-default" :title="http.path">{{ http.path }}</span>
      </span>
      <span v-else class="min-w-0 flex-1 truncate text-default" :title="row.message">{{ row.message || '—' }}</span>

      <!-- Right lane: status · latency · micro-bar -->
      <template v-if="http">
        <span class="w-9 shrink-0 text-right font-semibold tabular-nums" :class="statusClass(http.status)">
          {{ http.status ?? '—' }}
        </span>
        <span class="w-14 shrink-0 text-right tabular-nums" :class="lastMs !== undefined ? latencyClass(lastMs) : 'text-dimmed'">
          {{ lastMs !== undefined ? formatMs(lastMs) : '' }}
        </span>
        <span class="hidden h-1.5 w-14 shrink-0 overflow-hidden rounded-full bg-accented/60 sm:block">
          <span
            v-if="lastMs !== undefined"
            class="block h-full rounded-full"
            :class="latencyBarClass(lastMs)"
            :style="{ width: `${latencyFill(lastMs)}%` }"
          />
        </span>
      </template>

      <!-- Repeat counter -->
      <span
        v-if="count > 1"
        class="shrink-0 rounded-full bg-accented px-1.5 py-px text-[0.65rem] font-semibold tabular-nums text-muted"
        :title="`${count} consecutive identical lines`"
      >×{{ count }}</span>

      <UIcon
        :name="expanded ? 'i-ph-caret-up' : 'i-ph-caret-down'"
        class="size-3.5 shrink-0 text-dimmed"
      />
    </button>

    <!-- Detail -->
    <div v-if="expanded" class="border-t border-default/50 bg-default/40 px-4 py-3 text-muted">
      <div v-if="count > 1 || latStats" class="mb-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-dimmed">
        <span v-if="count > 1">{{ count }} occurrences</span>
        <span v-if="latStats">avg {{ formatMs(latStats.avg) }} · max {{ formatMs(latStats.max) }}</span>
      </div>

      <dl class="grid grid-cols-[minmax(6rem,auto)_1fr] gap-x-4 gap-y-1">
        <template v-for="f in fields" :key="f.key">
          <dt class="text-dimmed">
            {{ f.key }}
          </dt>
          <dd class="min-w-0 break-words text-toned select-text">
            {{ f.value }}
          </dd>
        </template>
      </dl>

      <div class="mt-3 flex items-center gap-2">
        <UButton
          :icon="showRaw ? 'i-ph-caret-up' : 'i-ph-code'"
          :label="showRaw ? 'Hide raw' : 'Raw JSON'"
          color="neutral"
          variant="ghost"
          size="xs"
          @click="toggleRaw"
        />
        <UButton icon="i-ph-copy" label="Copy" color="neutral" variant="ghost" size="xs" @click="copyRaw" />
      </div>

      <pre v-if="showRaw" class="mt-2 overflow-x-auto rounded-md border border-default/50 bg-elevated/40 p-3 text-toned select-text">{{ rawJson(row) }}</pre>
    </div>
  </div>
</template>
