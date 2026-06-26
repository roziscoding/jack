<script setup lang="ts">
defineProps<{
  label: string
  value: string | number
  hint?: string
  icon?: string
}>()
</script>

<template>
  <UCard variant="subtle" :ui="{ body: 'space-y-1' }">
    <div class="flex items-center justify-between gap-2">
      <p class="text-sm text-muted">
        {{ label }}
      </p>
      <UIcon v-if="icon" :name="icon" class="size-4 shrink-0 text-dimmed" />
    </div>
    <p class="text-2xl font-semibold tabular-nums text-highlighted">
      {{ value }}
    </p>
    <p v-if="hint" class="text-xs text-muted">
      {{ hint }}
    </p>
  </UCard>
</template>
