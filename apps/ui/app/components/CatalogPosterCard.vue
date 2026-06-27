<script setup lang="ts">
import type { CatalogTitle } from '~/types/management'

const props = defineProps<{ title: CatalogTitle }>()
defineEmits<{ select: [] }>()

const { load, entryFor } = useCatalogMetadata()
const entry = computed(() => entryFor(props.title))
const metadata = computed(() => entry.value?.data ?? props.title.metadata ?? null)
// Loading until the lookup settles; titles with no tmdbId never load, so they're
// not "loading" — they just stay on the placeholder.
const loading = computed(() => props.title.tmdbId != null && (entry.value === null || entry.value.status === 'loading'))

const name = computed(() => metadata.value?.title ?? props.title.displayTitle)
const poster = computed(() => metadata.value?.posterUrl ?? null)
const year = computed(() => metadata.value?.year ?? null)
const rating = computed(() => metadata.value?.rating ?? null)

onMounted(() => load(props.title))
</script>

<template>
  <button
    type="button"
    class="group flex flex-col gap-2 text-left focus:outline-none"
    @click="$emit('select')"
  >
    <div class="relative aspect-[2/3] overflow-hidden rounded-lg bg-muted ring-1 ring-default transition group-hover:ring-primary">
      <img
        v-if="poster"
        :src="poster"
        :alt="name"
        loading="lazy"
        class="size-full object-cover"
      >
      <div v-else class="flex size-full items-center justify-center" :class="{ 'animate-pulse': loading }">
        <UIcon :name="title.mediaType === 'tv' ? 'i-ph-television' : 'i-ph-film-strip'" class="size-8 text-dimmed" />
      </div>
      <UBadge
        v-if="rating"
        :label="rating.toFixed(1)"
        color="neutral"
        variant="solid"
        size="sm"
        icon="i-ph-star-fill"
        class="absolute right-1.5 top-1.5 bg-default/80 backdrop-blur"
      />
    </div>
    <div class="min-w-0">
      <p class="truncate text-sm font-medium text-default" :title="name">
        {{ name }}
      </p>
      <p class="text-xs text-muted">
        <span v-if="year">{{ year }} · </span>{{ title.mediaType === 'tv' ? 'TV' : 'Movie' }}
      </p>
    </div>
  </button>
</template>
