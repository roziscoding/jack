<script setup lang="ts">
import type { CatalogTitle } from '~/types/management'

const props = defineProps<{ title: CatalogTitle }>()
const emit = defineEmits<{ download: [] }>()

const { load, entryFor } = useCatalogMetadata()
// Reuse the cache the grid populated; load() is a no-op if the card already fetched it.
const meta = computed(() => entryFor(props.title)?.data ?? props.title.metadata ?? null)
const name = computed(() => meta.value?.title ?? props.title.displayTitle)
// Prefer the wide backdrop, fall back to the poster — covers titles with only one
// image and transient TMDB load failures (the poster is usually already cached by
// the card). Null once both fail, so the box is hidden rather than left blank.
const { src: heroImage, onError: onHeroError } = useFallbackImage(() => [
  meta.value?.backdropUrl,
  meta.value?.posterUrl,
])

onMounted(() => load(props.title))
const canRequest = computed(() => props.title.mediaType === 'tv'
  ? props.title.tvdbId != null
  : props.title.tmdbId != null)
</script>

<template>
  <div class="space-y-4">
    <div v-if="heroImage" class="aspect-video overflow-hidden rounded-lg bg-muted">
      <img :src="heroImage" :alt="name" class="size-full object-cover" @error="onHeroError">
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
      {{ title.releaseCount }} release{{ title.releaseCount === 1 ? '' : 's' }} across
      {{ title.peers.length }} peer{{ title.peers.length === 1 ? '' : 's' }} · {{ formatBytes(title.totalSize) }}
    </p>
    <p v-if="title.mediaType === 'tv'" class="text-xs text-muted">
      Downloads every available episode from the chosen peer.
    </p>

    <UTooltip :disabled="canRequest" text="This title has no matching id to request">
      <UButton
        label="Download"
        icon="i-ph-download-simple"
        :disabled="!canRequest"
        block
        @click="emit('download')"
      />
    </UTooltip>
  </div>
</template>
