<script setup lang="ts">
defineProps<{
  title: string
  description?: string
}>()
</script>

<template>
  <section class="flex flex-col gap-x-8 gap-y-4 lg:flex-row">
    <div class="lg:w-72 lg:shrink-0">
      <h2 class="text-sm font-semibold text-highlighted">
        {{ title }}
      </h2>
      <p v-if="description" class="mt-1 text-xs text-muted">
        {{ description }}
      </p>
      <div v-if="$slots.aside" class="mt-3">
        <slot name="aside" />
      </div>
    </div>

    <div class="min-w-0 flex-1">
      <slot />
    </div>
  </section>
</template>
