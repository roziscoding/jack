<script setup lang="ts">
// A stacked column with a leader line from each segment to its label. Past
// seven items the rest fold into an "Other" segment on top of the column, and a
// second column next to it breaks that segment down.
const props = defineProps<{
  items: { label: string, value: number }[]
  format: (value: number) => string
  empty: string
}>()

const KEPT = 7
const SLOTS = 8
const COLUMN = 32
const LINE_GAP = 18
const MIN_HEIGHT = 240
// Horizontal room for a leader line, and for the longest label (error codes run
// to about 22 characters).
const LEADER = 24
const LABEL = 196
// x positions: main labels end left of the main column, breakdown labels start
// right of the breakdown column.
const MAIN_X = LABEL
const REST_X = MAIN_X + COLUMN + 40
const WIDTH = REST_X + COLUMN + LEADER + LABEL

interface Segment { label: string, value: number, color: string, top: number, h: number, mid: number, labelY: number }

const sorted = computed(() => [...props.items].filter(i => i.value > 0).sort((a, b) => b.value - a.value))
const kept = computed(() => sorted.value.length > SLOTS
  ? sorted.value.slice(0, KEPT)
  : sorted.value)
const rest = computed(() => sorted.value.slice(kept.value.length))
const total = computed(() => sorted.value.reduce((sum, i) => sum + i.value, 0))
const restTotal = computed(() => rest.value.reduce((sum, i) => sum + i.value, 0))

const height = computed(() => Math.max(MIN_HEIGHT, (Math.max(kept.value.length + 1, rest.value.length) + 1) * LINE_GAP))

// Stacks `items` bottom up over the full height, then spaces the labels so they
// never overlap, each staying as close to its segment as it can.
function stack(items: { label: string, value: number, color: string }[], sum: number): Segment[] {
  const h = height.value
  let bottom = h
  const segments = items.map((item) => {
    const size = sum > 0
      ? (item.value / sum) * h
      : 0
    const top = bottom - size
    bottom = top
    return {
      ...item,
      top,
      h: size,
      mid: top + size / 2,
      labelY: top + size / 2,
    }
  })
  const byY = [...segments].sort((a, b) => a.mid - b.mid)
  for (const [i, s] of byY.entries()) {
    s.labelY = Math.max(s.mid, i === 0
      ? LINE_GAP / 2
      : byY[i - 1]!.labelY + LINE_GAP)
  }
  const overflow = (byY.at(-1)?.labelY ?? 0) - (h - LINE_GAP / 2)
  if (overflow > 0) {
    for (const s of byY)
      s.labelY -= overflow
    for (let i = byY.length - 2; i >= 0; i--)
      byY[i]!.labelY = Math.min(byY[i]!.labelY, byY[i + 1]!.labelY - LINE_GAP)
  }
  return segments
}

const OTHER_COLOR = 'var(--ui-text-dimmed)'

const main = computed(() => {
  const items = kept.value.map((item, i) => ({ ...item, color: `var(--viz-${i + 1})` }))
  // Other goes last, so it lands on top.
  if (rest.value.length)
    items.push({ label: `Other (${rest.value.length} codes)`, value: restTotal.value, color: OTHER_COLOR })
  return stack(items, total.value)
})

const breakdown = computed(() => stack(rest.value.map((item, i) => ({ ...item, color: `var(--viz-${(i % SLOTS) + 1})` })), restTotal.value))

// The band from the Other segment to the full breakdown column.
const band = computed(() => {
  const other = main.value.at(-1)
  if (!rest.value.length || !other)
    return ''
  const x1 = MAIN_X + COLUMN + 3
  const x2 = REST_X - 3
  return `M${x1},${other.top} L${x2},0 L${x2},${height.value} L${x1},${other.top + other.h} Z`
})
</script>

<template>
  <p v-if="sorted.length === 0" class="py-4 text-sm text-muted">
    {{ empty }}
  </p>
  <div v-else class="overflow-x-auto">
    <svg :width="WIDTH" :height="height" class="block max-w-none overflow-visible" role="img" :aria-label="`Failed downloads by error code, ${format(total)} in total`">
      <path v-if="band" :d="band" fill="var(--ui-text-dimmed)" fill-opacity="0.12" />

      <g v-for="s in main" :key="s.label">
        <rect :x="MAIN_X" :y="s.top" :width="COLUMN" :height="Math.max(0, s.h - 1)" :fill="s.color" rx="2">
          <title>{{ s.label }}: {{ format(s.value) }}</title>
        </rect>
        <polyline
          :points="`${MAIN_X - 3},${s.mid} ${MAIN_X - 8},${s.mid} ${MAIN_X - LEADER + 6},${s.labelY} ${MAIN_X - LEADER + 2},${s.labelY}`"
          fill="none"
          class="stroke-(--ui-border-accented)"
          stroke-width="1"
        />
        <text :x="MAIN_X - LEADER" :y="s.labelY" text-anchor="end" dominant-baseline="middle" class="text-xs">
          <tspan class="fill-(--ui-text)">{{ s.label }}</tspan>
          <tspan dx="8" class="fill-(--ui-text-muted) tabular-nums">{{ format(s.value) }}</tspan>
        </text>
      </g>

      <g v-for="s in breakdown" :key="s.label">
        <rect :x="REST_X" :y="s.top" :width="COLUMN" :height="Math.max(0, s.h - 1)" :fill="s.color" rx="2">
          <title>{{ s.label }}: {{ format(s.value) }}</title>
        </rect>
        <polyline
          :points="`${REST_X + COLUMN + 3},${s.mid} ${REST_X + COLUMN + 8},${s.mid} ${REST_X + COLUMN + LEADER - 6},${s.labelY} ${REST_X + COLUMN + LEADER - 2},${s.labelY}`"
          fill="none"
          class="stroke-(--ui-border-accented)"
          stroke-width="1"
        />
        <text :x="REST_X + COLUMN + LEADER" :y="s.labelY" dominant-baseline="middle" class="text-xs">
          <tspan class="fill-(--ui-text)">{{ s.label }}</tspan>
          <tspan dx="8" class="fill-(--ui-text-muted) tabular-nums">{{ format(s.value) }}</tspan>
        </text>
      </g>
    </svg>

    <table class="sr-only">
      <thead>
        <tr>
          <th>Error code</th>
          <th>Failed downloads</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="item in sorted" :key="item.label">
          <td>{{ item.label }}</td>
          <td>{{ format(item.value) }}</td>
        </tr>
      </tbody>
    </table>
  </div>
</template>
