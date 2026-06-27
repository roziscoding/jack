<script setup lang="ts">
import type { CatalogTitle } from '~/types/management'

const props = defineProps<{ title: CatalogTitle }>()
defineEmits<{ select: [] }>()

const { load, entryFor } = useCatalogMetadata()
const entry = computed(() => entryFor(props.title))
const metadata = computed(() => entry.value?.data ?? props.title.metadata ?? null)

// Three visual states: the lookup is in flight, it finished with nothing (or there
// was no id to look up), or we have metadata.
const status = computed<'loading' | 'unavailable' | 'ready'>(() => {
  if (metadata.value)
    return 'ready'
  if (props.title.tmdbId == null)
    return 'unavailable'
  return entry.value === null || entry.value.status === 'loading' ? 'loading' : 'unavailable'
})

const name = computed(() => metadata.value?.title ?? props.title.displayTitle)
// Prefer the poster, fall back to the backdrop — both for titles that only have one
// and for transient TMDB load failures (object-cover crops it to the card shape).
const { src: poster, onError: onPosterError } = useFallbackImage(() => [
  metadata.value?.posterUrl,
  metadata.value?.backdropUrl,
])
const year = computed(() => metadata.value?.year ?? null)
const rating = computed(() => metadata.value?.rating ?? null)
const typeLabel = computed(() => props.title.mediaType === 'tv' ? 'TV' : 'Movie')
const mediaIcon = computed(() => props.title.mediaType === 'tv' ? 'i-ph-television' : 'i-ph-film-strip')

// Enrich only once the card nears the viewport, so off-screen cards don't all
// fire lookups at once. rootMargin starts the fetch just before it scrolls in.
const cardRef = ref<HTMLElement | null>(null)
let observer: IntersectionObserver | null = null
onMounted(() => {
  observer = new IntersectionObserver((entries) => {
    if (!entries.some(entry => entry.isIntersecting))
      return
    load(props.title)
    observer?.disconnect()
    observer = null
  }, { rootMargin: '300px' })
  if (cardRef.value)
    observer.observe(cardRef.value)
})
onBeforeUnmount(() => observer?.disconnect())
</script>

<template>
  <button
    ref="cardRef"
    type="button"
    class="group flex flex-col gap-2 text-left focus:outline-none"
    @click="$emit('select')"
  >
    <div class="relative aspect-[2/3] overflow-hidden rounded-lg bg-muted ring-1 ring-default transition group-hover:ring-primary">
      <!-- No loading="lazy": the IntersectionObserver already defers the poster URL
           until the card nears the viewport, and native lazy-loading is unreliable
           inside the panel's internal scroll container (images stay blank until the
           window scrolls, which it never does here). -->
      <img
        v-if="poster"
        :src="poster"
        :alt="name"
        class="size-full object-cover"
        @error="onPosterError"
      >
      <!-- Loading: pulsing surface with a spinner. -->
      <div v-else-if="status === 'loading'" class="flex size-full animate-pulse items-center justify-center">
        <UIcon name="i-ph-circle-notch" class="size-7 animate-spin text-dimmed" />
      </div>
      <!-- Metadata unavailable: dimmed broken-image mark, no pulse. -->
      <div v-else-if="status === 'unavailable'" class="flex size-full items-center justify-center text-dimmed">
        <UIcon name="i-ph-image-broken" class="size-8" />
      </div>
      <!-- Metadata present but no poster image: fall back to the media-type icon. -->
      <div v-else class="flex size-full items-center justify-center">
        <UIcon :name="mediaIcon" class="size-8 text-dimmed" />
      </div>
      <UBadge
        v-if="rating"
        :label="rating.toFixed(1)"
        variant="solid"
        size="sm"
        icon="i-ph-star-fill"
        class="absolute right-1.5 top-1.5 gap-0.5 bg-black/65 font-semibold text-amber-300 ring-1 ring-white/10 backdrop-blur"
        :ui="{ leadingIcon: 'text-amber-400' }"
      />
    </div>
    <div class="min-w-0">
      <p class="truncate text-sm font-medium text-default" :title="name">
        {{ name }}
      </p>
      <p v-if="status === 'ready'" class="truncate text-xs text-muted">
        <span v-if="year">{{ year }} · </span>{{ typeLabel }}
      </p>
      <div v-else-if="status === 'loading'" class="mt-1 h-3 w-12 animate-pulse rounded bg-muted" />
      <p v-else class="truncate text-xs text-dimmed">
        {{ typeLabel }} · no metadata
      </p>
    </div>
  </button>
</template>
