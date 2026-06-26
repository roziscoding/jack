<script setup lang="ts">
import type { RefreshOption } from '~/composables/useAutoRefresh'

const props = defineProps<{
  options: RefreshOption[]
  intervalMs: number
  paused: boolean
  secondsLeft: number
}>()
const emit = defineEmits<{ 'update:intervalMs': [number], 'toggle': [] }>()

const items = computed(() => props.options.map(o => ({ label: `Every ${o.label}`, value: o.ms })))
const model = computed({
  get: () => props.intervalMs,
  set: v => emit('update:intervalMs', v),
})
</script>

<template>
  <div class="flex items-center gap-2">
    <span class="hidden text-xs tabular-nums text-muted sm:inline">
      {{ paused ? 'Auto-refresh paused' : `Next refresh in ${secondsLeft}s` }}
    </span>
    <USelect v-model="model" :items="items" size="sm" class="w-32" aria-label="Auto-refresh interval" />
    <UButton
      size="sm"
      color="neutral"
      variant="subtle"
      :icon="paused ? 'i-ph-play' : 'i-ph-pause'"
      :label="paused ? 'Resume' : 'Pause'"
      @click="emit('toggle')"
    />
  </div>
</template>
