<script setup lang="ts">
export interface ColumnSeries {
  name: string
  /** A CSS color, e.g. `var(--viz-1)`. */
  color: string
  values: number[]
}

const props = defineProps<{
  /** UTC days, oldest first, one column each. */
  days: string[]
  /** Stacked bottom to top in this order. */
  series: ColumnSeries[]
  format: (value: number) => string
}>()

const totals = computed(() => props.days.map((_, i) => props.series.reduce((sum, s) => sum + (s.values[i] ?? 0), 0)))
const max = computed(() => Math.max(0, ...totals.value))

// The top segment carries the rounded data-end; the baseline stays square.
function topIndex(i: number): number {
  return props.series.findLastIndex(s => (s.values[i] ?? 0) > 0)
}

function describe(i: number): string {
  const parts = props.series.map(s => `${s.name} ${props.format(s.values[i] ?? 0)}`)
  return `${formatDay(props.days[i]!)}: ${parts.join(' · ')}`
}
</script>

<template>
  <div>
    <div v-if="series.length > 1" class="mb-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
      <span v-for="s in series" :key="s.name" class="flex items-center gap-1.5">
        <span class="size-2.5 rounded-sm" :style="{ background: s.color }" />
        {{ s.name }}
      </span>
    </div>

    <div class="flex gap-2">
      <div class="flex h-40 w-16 shrink-0 flex-col justify-between text-right text-[10px] tabular-nums text-dimmed" aria-hidden="true">
        <span>{{ format(max) }}</span>
        <span>0</span>
      </div>
      <div class="flex h-40 min-w-0 flex-1 items-end gap-0.5 border-b border-default">
        <UTooltip v-for="(day, i) in days" :key="day" :text="describe(i)">
          <div class="flex h-full flex-1 items-end justify-center" tabindex="0" :aria-label="describe(i)">
            <div
              v-if="totals[i]! > 0"
              class="flex w-full max-w-6 flex-col-reverse gap-0.5"
              :style="{ height: `${(totals[i]! / max) * 100}%` }"
            >
              <template v-for="(s, si) in series" :key="s.name">
                <div
                  v-if="(s.values[i] ?? 0) > 0"
                  :class="si === topIndex(i) && 'rounded-t'"
                  :style="{ flexGrow: s.values[i], flexBasis: 0, background: s.color, minHeight: '2px' }"
                />
              </template>
            </div>
          </div>
        </UTooltip>
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
            {{ format(s.values[i] ?? 0) }}
          </td>
        </tr>
      </tbody>
    </table>
  </div>
</template>
