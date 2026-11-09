<script setup lang="ts">
export interface LineSeries {
  name: string
  /** A CSS color, e.g. `var(--viz-1)`. */
  color: string
  /** One per day; null leaves a gap in the line. */
  values: (number | null)[]
}

const props = defineProps<{
  days: string[]
  series: LineSeries[]
  format: (value: number) => string
}>()

const HEIGHT = 160
const PAD = 6

// Drawn at the real pixel width so lines and dots keep their shape.
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

const max = computed(() => Math.max(0, ...props.series.flatMap(s => s.values.filter((v): v is number => v != null))))

function x(i: number): number {
  return props.days.length > 1
    ? PAD + (i / (props.days.length - 1)) * (width.value - 2 * PAD)
    : width.value / 2
}

function y(v: number): number {
  return max.value > 0
    ? HEIGHT - PAD - (v / max.value) * (HEIGHT - 2 * PAD)
    : HEIGHT - PAD
}

// A null value breaks the line; each run of values is its own subpath.
function path(values: (number | null)[]): string {
  const parts: string[] = []
  let drawing = false
  for (const [i, v] of values.entries()) {
    if (v == null) {
      drawing = false
      continue
    }
    parts.push(`${drawing ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`)
    drawing = true
  }
  return parts.join(' ')
}

// A value with no neighbor draws no line, so it gets a dot.
function isolated(values: (number | null)[], i: number): boolean {
  return values[i] != null && values[i - 1] == null && values[i + 1] == null
}

const hover = ref<number | null>(null)
function onMove(event: PointerEvent) {
  const box = plot.value!.getBoundingClientRect()
  const ratio = (event.clientX - box.left - PAD) / Math.max(1, box.width - 2 * PAD)
  hover.value = Math.min(props.days.length - 1, Math.max(0, Math.round(ratio * (props.days.length - 1))))
}

// Keyboard users read the chart day by day: focus lands on the latest day, the
// arrows step through, Home/End jump to either edge. The tooltip is the readout.
function onKey(event: KeyboardEvent) {
  const last = props.days.length - 1
  const current = hover.value ?? last
  const next = {
    ArrowLeft: current - 1,
    ArrowRight: current + 1,
    Home: 0,
    End: last,
  }[event.key]
  if (next === undefined)
    return
  event.preventDefault()
  hover.value = Math.min(last, Math.max(0, next))
}
</script>

<template>
  <div>
    <div v-if="series.length > 1" class="mb-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
      <span v-for="s in series" :key="s.name" class="flex items-center gap-1.5">
        <span class="h-0.5 w-3 rounded-full" :style="{ background: s.color }" />
        {{ s.name }}
      </span>
    </div>

    <div class="flex gap-2">
      <div class="flex h-40 w-16 shrink-0 flex-col justify-between text-right text-[10px] tabular-nums text-dimmed" aria-hidden="true">
        <span>{{ format(max) }}</span>
        <span>0</span>
      </div>
      <div
        ref="plot"
        class="relative h-40 min-w-0 flex-1 rounded-sm border-b border-default focus-visible:outline-2 focus-visible:outline-primary"
        tabindex="0"
        role="group"
        :aria-label="`${series.map(s => s.name).join(', ')}, by day. Use the arrow keys to read each day.`"
        @pointermove="onMove"
        @pointerleave="hover = null"
        @focus="hover ??= days.length - 1"
        @blur="hover = null"
        @keydown="onKey"
      >
        <svg :width="width" :height="HEIGHT" class="block overflow-visible" aria-hidden="true">
          <line
            v-if="hover !== null"
            :x1="x(hover)"
            :x2="x(hover)"
            y1="0"
            :y2="HEIGHT"
            class="stroke-(--ui-border-accented)"
            stroke-width="1"
          />
          <g v-for="s in series" :key="s.name">
            <path :d="path(s.values)" fill="none" :stroke="s.color" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" />
            <template v-for="(v, i) in s.values" :key="i">
              <circle
                v-if="v != null && (isolated(s.values, i) || hover === i)"
                :cx="x(i)"
                :cy="y(v)"
                :r="hover === i ? 4 : 3"
                :fill="s.color"
                class="stroke-(--ui-bg-elevated)"
                stroke-width="2"
              />
            </template>
          </g>
        </svg>

        <div
          v-if="hover !== null"
          class="pointer-events-none absolute top-0 z-10 rounded-md border border-default bg-elevated px-2.5 py-1.5 text-xs shadow-sm"
          aria-live="polite"
          :class="x(hover) > width / 2 ? '-translate-x-full -ml-2' : 'ml-2'"
          :style="{ left: `${x(hover)}px` }"
        >
          <p class="font-medium text-highlighted">
            {{ formatDay(days[hover]!) }}
          </p>
          <p v-for="s in series" :key="s.name" class="flex items-center gap-1.5 text-muted">
            <span class="h-0.5 w-2.5 rounded-full" :style="{ background: s.color }" />
            {{ s.name }}
            <span class="ml-auto pl-3 tabular-nums text-default">{{ s.values[hover] == null ? '—' : format(s.values[hover]!) }}</span>
          </p>
        </div>
      </div>
    </div>
    <div class="ml-18 mt-1 flex justify-between text-[10px] text-dimmed" aria-hidden="true">
      <span>{{ formatDay(days[0]!) }}</span>
      <span>{{ formatDay(days.at(-1)!) }}</span>
    </div>

    <table class="sr-only">
      <thead>
        <tr>
          <th>Day</th>
          <th v-for="s in series" :key="s.name">
            {{ s.name }}
          </th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="(day, i) in days" :key="day">
          <td>{{ formatDay(day) }}</td>
          <td v-for="s in series" :key="s.name">
            {{ s.values[i] == null ? 'no data' : format(s.values[i]!) }}
          </td>
        </tr>
      </tbody>
    </table>
  </div>
</template>
