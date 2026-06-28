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

// Peer chips along the poster's bottom edge: up to two name badges (CSS-truncated to
// stay legible, and to shrink rather than overflow on small posters) then a "+N" badge
// whose tooltip names the rest.
const visiblePeers = computed(() => props.title.peers.slice(0, 2))
const hiddenPeers = computed(() => props.title.peers.slice(2))
const { dotClass } = usePeerColors()

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
      <!-- Peers along the bottom, filling right-to-left so the first peer sits at the
           right edge. -->
      <div
        v-if="title.peers.length"
        class="absolute inset-x-1.5 bottom-1.5 flex justify-end gap-1"
      >
        <UTooltip
          v-for="p in visiblePeers"
          :key="p.id"
          :text="`From ${p.name}'s library`"
        >
          <UBadge
            :label="p.name"
            variant="solid"
            size="sm"
            class="min-w-0 max-w-24 bg-black/65 font-medium text-white ring-1 ring-white/10 backdrop-blur"
          >
            <template #leading>
              <span class="size-1.5 shrink-0 rounded-full" :class="dotClass(p.id)" />
            </template>
          </UBadge>
        </UTooltip>
        <UTooltip v-if="hiddenPeers.length" :ui="{ content: 'h-auto' }">
          <template #content>
            <div class="text-xs">
              <p class="font-medium">
                Also available from:
              </p>
              <ul class="mt-0.5 space-y-0.5">
                <li v-for="p in hiddenPeers" :key="p.id" class="flex items-center gap-1.5 whitespace-nowrap">
                  <span class="size-1.5 shrink-0 rounded-full" :class="dotClass(p.id)" />
                  {{ p.name }}'s library
                </li>
              </ul>
            </div>
          </template>
          <UBadge
            :label="`+${hiddenPeers.length}`"
            variant="solid"
            size="sm"
            class="shrink-0 bg-black/65 font-medium text-white ring-1 ring-white/10 backdrop-blur"
          />
        </UTooltip>
      </div>
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
