<script setup lang="ts">
import type { BadgeProps } from '@nuxt/ui'

defineProps<{
  name: string
  url: string
  initialized: boolean
  error?: string | null
  status: { color: BadgeProps['color'], label: string }
  to?: string
  // Optional identity accent (e.g. a peer's derived text-color class) applied to the
  // status icon. Left unset for connectors, which have no per-entry color.
  accentClass?: string | null
}>()
defineEmits<{ edit: [], remove: [] }>()
</script>

<template>
  <UCard variant="subtle" :ui="{ body: 'sm:p-4' }">
    <div class="flex items-center gap-3">
      <ConnDot :initialized="initialized" :error="error" :accent-class="accentClass" />
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
      <UButton v-if="to" :to="to" icon="i-ph-list-magnifying-glass" color="neutral" variant="ghost" size="sm" :aria-label="`Browse ${name} catalog`" />
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
