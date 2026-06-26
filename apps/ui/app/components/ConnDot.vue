<script setup lang="ts">
const props = defineProps<{
  initialized: boolean
  error?: string | null
}>()

// Connected → success; unreachable (failed to initialize, has an error) → error;
// still handshaking → warning. A soft halo ring gives the live console a pulse
// without any custom CSS.
const dot = computed(() => {
  if (props.initialized)
    return 'bg-success ring-success/20'
  if (props.error)
    return 'bg-error ring-error/20'
  return 'bg-warning ring-warning/20'
})
</script>

<template>
  <span class="size-2 shrink-0 rounded-full ring-4" :class="dot" :title="error ?? undefined" />
</template>
