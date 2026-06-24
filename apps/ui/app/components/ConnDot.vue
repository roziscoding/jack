<script setup lang="ts">
const props = defineProps<{
  initialized: boolean
  error?: string | null
}>()

// Connected → emerald; unreachable (failed to initialize, has an error) → rose;
// still handshaking → amber. Mirrors StatusBadge's three tones.
const tone = computed(() => (props.initialized ? 'up' : props.error ? 'down' : 'pending'))
</script>

<template>
  <span class="conn-dot" :class="`conn-dot--${tone}`" :title="error ?? undefined" />
</template>
