<script setup lang="ts">
import type { BadgeProps } from '@nuxt/ui'

defineProps<{
  name: string
  url: string
  initialized: boolean
  error?: string | null
  status: { color: BadgeProps['color'], label: string }
}>()
defineEmits<{ edit: [], remove: [] }>()
</script>

<template>
  <UCard variant="subtle" :ui="{ body: 'sm:p-4' }">
    <div class="flex items-center gap-3">
      <ConnDot :initialized="initialized" :error="error" />
      <div class="min-w-0 flex-1">
        <div class="flex items-baseline gap-2">
          <span class="truncate font-medium text-default" :title="name">{{ name }}</span>
          <slot name="badge" />
        </div>
        <p class="truncate font-mono text-xs text-muted" :title="url">
          {{ url }}
        </p>
      </div>
      <UBadge v-bind="status" variant="subtle" />
      <UButton icon="i-ph-pencil-simple" color="neutral" variant="ghost" size="sm" :aria-label="`Edit ${name}`" @click="$emit('edit')" />
      <UButton icon="i-ph-trash" color="neutral" variant="ghost" size="sm" :aria-label="`Remove ${name}`" @click="$emit('remove')" />
    </div>

    <slot name="meta" />

    <UAlert
      v-if="!initialized && error"
      class="mt-3"
      color="error"
      variant="soft"
      :ui="{ description: 'font-mono text-xs' }"
      :description="error"
    />
  </UCard>
</template>
