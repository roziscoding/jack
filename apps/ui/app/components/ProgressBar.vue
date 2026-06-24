<script setup lang="ts">
const props = defineProps<{ value: number | null }>()
const pct = computed(() => (props.value == null ? null : Math.round(props.value * 100)))
</script>

<template>
  <div class="flex items-center gap-2">
    <div class="h-1.5 w-full overflow-hidden rounded-full bg-slate-800">
      <div
        class="h-full rounded-full bg-brand-500 transition-all"
        :style="{ width: `${pct ?? 0}%` }"
      />
    </div>
    <span class="w-9 shrink-0 text-right text-xs tabular-nums text-slate-400">
      {{ pct == null ? '—' : `${pct}%` }}
    </span>
  </div>
</template>
