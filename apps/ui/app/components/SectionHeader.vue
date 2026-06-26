<script setup lang="ts">
defineProps<{
  icon: string
  title: string
  description?: string
}>()
</script>

<template>
  <div class="flex items-end justify-between gap-4">
    <div class="flex items-center gap-3">
      <span class="flex size-9 shrink-0 items-center justify-center rounded-lg bg-elevated">
        <UIcon :name="icon" class="size-5 text-muted" />
      </span>
      <div>
        <h2 class="text-sm font-semibold text-highlighted">
          {{ title }}
        </h2>
        <p v-if="description" class="text-xs text-muted">
          {{ description }}
        </p>
      </div>
    </div>
    <slot name="action" />
  </div>
</template>
