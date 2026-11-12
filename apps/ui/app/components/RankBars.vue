<script setup lang="ts">
const props = defineProps<{
  // `key` identifies the row when labels can repeat (two peers with one name).
  items: { key?: string, label: string, value: number, hint?: string }[]
  format: (value: number) => string
  /** A CSS color, e.g. `var(--viz-1)`. */
  color: string
  empty: string
}>()

const max = computed(() => Math.max(0, ...props.items.map(i => i.value)))
</script>

<template>
  <p v-if="items.length === 0" class="py-4 text-sm text-muted">
    {{ empty }}
  </p>
  <ul v-else class="space-y-3">
    <li v-for="item in items" :key="item.key ?? item.label">
      <div class="flex items-baseline justify-between gap-3 text-sm">
        <span class="min-w-0 truncate text-default" :title="item.label">{{ item.label }}</span>
        <span class="shrink-0 text-xs tabular-nums text-muted">
          {{ format(item.value) }}<template v-if="item.hint"> · {{ item.hint }}</template>
        </span>
      </div>
      <div class="mt-1.5 h-2 rounded-full bg-elevated">
        <div class="h-2 rounded-full" :style="{ width: `${max > 0 ? Math.max(1, (item.value / max) * 100) : 0}%`, background: color }" />
      </div>
    </li>
  </ul>
</template>
