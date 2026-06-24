<script setup lang="ts">
defineProps<{
  label: string
  value: string | number
  hint?: string
}>()
</script>

<template>
  <div class="rounded-xl border border-slate-800 bg-slate-900/40 p-5">
    <p class="text-sm text-slate-400">
      {{ label }}
    </p>
    <p class="mt-2 text-2xl font-semibold tabular-nums">
      {{ value }}
    </p>
    <p v-if="hint" class="mt-1 text-xs text-slate-500">
      {{ hint }}
    </p>
  </div>
</template>
