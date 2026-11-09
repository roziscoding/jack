<script setup lang="ts">
import type { LineSeries } from './LineChart.vue'

// Two series on one x axis: `above` grows up from the axis, `below` grows down.
// Both share one scale, so equal values have equal heights. Drawn as areas, or
// as one bar per bucket.
const props = defineProps<{
  /** One per bucket, oldest first, already formatted for display. */
  labels: string[]
  above: LineSeries
  below: LineSeries
  format: (value: number) => string
  bars?: boolean
}>()

const HEIGHT = 200
const MID = HEIGHT / 2

const plot = ref<HTMLElement>()
const width = ref(600)
let observer: ResizeObserver | undefined
onMounted(() => {
  observer = new ResizeObserver(([entry]) => {
    width.value = Math.max(1, entry!.contentRect.width)
  })
  observer.observe(plot.value!)
})
onBeforeUnmount(() => observer?.disconnect())

// Bars need half a slot at each edge so the outer ones stay inside the plot.
const PAD = computed(() => props.bars
  ? width.value / Math.max(1, props.labels.length) / 2
  : 6)
const barWidth = computed(() => Math.min(24, (width.value / Math.max(1, props.labels.length)) * 0.7))

const series = computed(() => [props.above, props.below])
const max = computed(() => Math.max(0, ...series.value.flatMap(s => s.values.filter((v): v is number => v != null))))

function x(i: number): number {
  return props.labels.length > 1
    ? PAD.value + (i / (props.labels.length - 1)) * (width.value - 2 * PAD.value)
    : width.value / 2
}

// Distance from the axis; the caller picks the direction.
function offset(v: number): number {
  return max.value > 0
    ? (v / max.value) * (MID - 6)
    : 0
}

// A bucket with no value is drawn on the axis, so the area drops to zero between
// bursts of activity instead of breaking into slivers. The tooltip still says "—".
function edge(values: (number | null)[], sign: 1 | -1): string {
  return `M${values.map((v, i) => `${x(i).toFixed(1)},${(MID - sign * offset(v ?? 0)).toFixed(1)}`).join(' L')}`
}

function area(values: (number | null)[], sign: 1 | -1): string {
  if (values.length === 0)
    return ''
  return `${edge(values, sign)} L${x(values.length - 1).toFixed(1)},${MID} L${x(0).toFixed(1)},${MID} Z`
}

const hover = ref<number | null>(null)
function onMove(event: PointerEvent) {
  const box = plot.value!.getBoundingClientRect()
  const ratio = (event.clientX - box.left - PAD.value) / Math.max(1, box.width - 2 * PAD.value)
  hover.value = Math.min(props.labels.length - 1, Math.max(0, Math.round(ratio * (props.labels.length - 1))))
}

// Same keyboard model as LineChart: arrows step, Home/End jump.
function onKey(event: KeyboardEvent) {
  const last = props.labels.length - 1
  const current = hover.value ?? last
  const positions: Record<string, number> = {
    ArrowLeft: current - 1,
    ArrowRight: current + 1,
    Home: 0,
    End: last,
  }
  const next = positions[event.key]
  if (next === undefined)
    return
  event.preventDefault()
  hover.value = Math.min(last, Math.max(0, next))
}
</script>

<template>
  <div>
    <div class="mb-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
      <span class="flex items-center gap-1.5">
        <span class="size-2.5 rounded-xs" :style="{ background: above.color }" />
        {{ above.name }}
      </span>
      <span class="flex items-center gap-1.5">
        <span class="size-2.5 rounded-xs" :style="{ background: below.color }" />
        {{ below.name }}
      </span>
    </div>

    <div class="flex gap-2">
      <div class="flex h-50 w-16 shrink-0 flex-col justify-between text-right text-[10px] tabular-nums text-dimmed" aria-hidden="true">
        <span>{{ format(max) }}</span>
        <span>0</span>
        <span>{{ format(max) }}</span>
      </div>
      <div
        ref="plot"
        class="relative h-50 min-w-0 flex-1 rounded-sm focus-visible:outline-2 focus-visible:outline-primary"
        tabindex="0"
        role="group"
        :aria-label="`${above.name} and ${below.name}. Use the arrow keys to read each point.`"
        @pointermove="onMove"
        @pointerleave="hover = null"
        @focus="hover ??= labels.length - 1"
        @blur="hover = null"
        @keydown="onKey"
      >
        <svg :width="width" :height="HEIGHT" class="block overflow-visible" aria-hidden="true">
          <template v-if="bars">
            <template v-for="(v, i) in above.values" :key="`a${i}`">
              <rect v-if="v" :x="x(i) - barWidth / 2" :y="MID - offset(v)" :width="barWidth" :height="offset(v)" :fill="above.color" :opacity="hover === null || hover === i ? 1 : 0.5" rx="1" />
            </template>
            <template v-for="(v, i) in below.values" :key="`b${i}`">
              <rect v-if="v" :x="x(i) - barWidth / 2" :y="MID" :width="barWidth" :height="offset(v)" :fill="below.color" :opacity="hover === null || hover === i ? 1 : 0.5" rx="1" />
            </template>
          </template>
          <template v-else>
            <path :d="area(above.values, 1)" :fill="above.color" fill-opacity="0.35" />
            <path :d="edge(above.values, 1)" fill="none" :stroke="above.color" stroke-width="1.5" stroke-linejoin="round" />
            <path :d="area(below.values, -1)" :fill="below.color" fill-opacity="0.35" />
            <path :d="edge(below.values, -1)" fill="none" :stroke="below.color" stroke-width="1.5" stroke-linejoin="round" />
          </template>
          <line x1="0" :x2="width" :y1="MID" :y2="MID" class="stroke-(--ui-border-accented)" stroke-width="1" />
          <line
            v-if="hover !== null && !bars"
            :x1="x(hover)"
            :x2="x(hover)"
            y1="0"
            :y2="HEIGHT"
            class="stroke-(--ui-border-accented)"
            stroke-width="1"
          />
        </svg>

        <div
          v-if="hover !== null"
          class="pointer-events-none absolute top-0 z-10 rounded-md border border-default bg-elevated px-2.5 py-1.5 text-xs shadow-sm"
          aria-live="polite"
          :class="x(hover) > width / 2 ? '-translate-x-full -ml-2' : 'ml-2'"
          :style="{ left: `${x(hover)}px` }"
        >
          <p class="font-medium text-highlighted">
            {{ labels[hover] }}
          </p>
          <p v-for="s in series" :key="s.name" class="flex items-center gap-1.5 text-muted">
            <span class="size-2 rounded-xs" :style="{ background: s.color }" />
            {{ s.name }}
            <span class="ml-auto pl-3 tabular-nums text-default">{{ s.values[hover] == null ? '—' : format(s.values[hover]!) }}</span>
          </p>
        </div>
      </div>
    </div>
    <div class="ml-18 mt-1 flex justify-between text-[10px] text-dimmed" aria-hidden="true">
      <span>{{ labels[0] }}</span>
      <span>{{ labels.at(-1) }}</span>
    </div>

    <table class="sr-only">
      <thead>
        <tr>
          <th>Time</th>
          <th v-for="s in series" :key="s.name">
            {{ s.name }}
          </th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="(label, i) in labels" :key="i">
          <td>{{ label }}</td>
          <td v-for="s in series" :key="s.name">
            {{ s.values[i] == null ? 'no data' : format(s.values[i]!) }}
          </td>
        </tr>
      </tbody>
    </table>
  </div>
</template>
