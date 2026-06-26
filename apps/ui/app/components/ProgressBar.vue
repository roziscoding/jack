<script setup lang="ts">
const props = defineProps<{ value: number | null }>()
// null progress → UProgress renders its indeterminate animation; the label
// falls back to an em dash.
const pct = computed(() => (props.value == null ? null : Math.round(props.value * 100)))
</script>

<template>
  <div class="flex items-center gap-2">
    <UProgress :model-value="pct" size="sm" class="w-full" />
    <span class="w-9 shrink-0 text-right text-xs tabular-nums text-muted">
      {{ pct == null ? '—' : `${pct}%` }}
    </span>
  </div>
</template>
