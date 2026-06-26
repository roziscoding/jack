<script setup lang="ts">
import type { CatalogTitle } from '~/types/management'

const props = defineProps<{ title: CatalogTitle }>()
defineEmits<{ select: [] }>()

const name = computed(() => props.title.metadata?.title ?? props.title.displayTitle)
const poster = computed(() => props.title.metadata?.posterUrl ?? null)
const year = computed(() => props.title.metadata?.year ?? null)
const rating = computed(() => props.title.metadata?.rating ?? null)
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
      <div v-else class="flex size-full items-center justify-center">
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
