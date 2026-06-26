<script setup lang="ts">
import type { CatalogTitle } from '~/types/management'

const props = defineProps<{ title: CatalogTitle }>()

const name = computed(() => props.title.metadata?.title ?? props.title.displayTitle)
const meta = computed(() => props.title.metadata ?? null)
</script>

<template>
  <div class="space-y-4">
    <div v-if="meta?.backdropUrl" class="aspect-video overflow-hidden rounded-lg bg-muted">
      <img :src="meta.backdropUrl" :alt="name" class="size-full object-cover">
    </div>

    <div class="flex items-baseline gap-2">
      <h3 class="text-lg font-semibold text-highlighted">
        {{ name }}
      </h3>
      <span v-if="meta?.year" class="text-sm text-muted">{{ meta.year }}</span>
    </div>

    <div class="flex flex-wrap items-center gap-2">
      <UBadge :label="title.mediaType === 'tv' ? 'TV' : 'Movie'" color="neutral" variant="subtle" />
      <UBadge v-if="meta?.rating" :label="meta.rating.toFixed(1)" icon="i-ph-star-fill" color="warning" variant="subtle" />
      <UBadge v-for="g in meta?.genres ?? []" :key="g" :label="g" color="neutral" variant="soft" size="sm" />
    </div>

    <p v-if="meta?.overview" class="text-sm leading-relaxed text-toned">
      {{ meta.overview }}
    </p>
    <p v-else class="text-sm text-muted">
      No description available.
    </p>

    <USeparator />

    <p class="text-xs text-muted">
      {{ title.releaseCount }} release{{ title.releaseCount === 1 ? '' : 's' }} on this peer · {{ formatBytes(title.totalSize) }}
    </p>

    <!-- Phase 5 inserts the Download button here. -->
  </div>
</template>
