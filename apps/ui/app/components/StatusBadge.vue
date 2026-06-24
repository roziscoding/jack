<script setup lang="ts">
const props = defineProps<{
  initialized: boolean
  error?: string | null
}>()

const tone = computed(() => (props.initialized ? 'ok' : props.error ? 'error' : 'pending'))
const label = computed(() => (props.initialized ? 'Connected' : props.error ? 'Error' : 'Pending'))
</script>

<template>
  <span
    class="inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium"
    :class="{
      'bg-emerald-950/60 text-emerald-300': tone === 'ok',
      'bg-rose-950/60 text-rose-300': tone === 'error',
      'bg-slate-800 text-slate-400': tone === 'pending',
    }"
    :title="error ?? undefined"
  >
    <span
      class="h-1.5 w-1.5 rounded-full"
      :class="{
        'bg-emerald-400': tone === 'ok',
        'bg-rose-400': tone === 'error',
        'bg-slate-500': tone === 'pending',
      }"
    />
    {{ label }}
  </span>
</template>
