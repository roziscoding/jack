<script setup lang="ts">
const props = defineProps<{
  initialized: boolean
  error?: string | null
  // Optional identity color (e.g. a peer's derived text-color class). When set it
  // overrides the status color: the plug shape carries the status, the color carries
  // identity. Left unset for connectors, which have no per-entry color.
  accentClass?: string | null
}>()

// Shape conveys status: connected → plugged together, otherwise → unplugged.
const icon = computed(() => props.initialized ? 'i-ph-plugs-connected' : 'i-ph-plugs')

// Color conveys identity when an accent is given, else falls back to the status color.
const color = computed(() => {
  if (props.accentClass)
    return props.accentClass
  if (props.initialized)
    return 'text-success'
  if (props.error)
    return 'text-error'
  return 'text-warning'
})

// Still handshaking (not initialized, no error yet): pulse to signal it's in progress.
const connecting = computed(() => !props.initialized && !props.error)
</script>

<template>
  <UIcon
    :name="icon"
    class="size-4 shrink-0"
    :class="[color, connecting && 'animate-pulse [animation-duration:0.8s]']"
    :title="error ?? undefined"
  />
</template>
