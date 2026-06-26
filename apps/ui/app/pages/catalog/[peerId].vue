<script setup lang="ts">
import type { CatalogTitle, PeerCatalogResponse } from '~/types/management'

const route = useRoute()
const peerId = computed(() => String(route.params.peerId))
const { request } = useManagement()

const { data, pending, error } = await useAsyncData(
  `catalog-${peerId.value}`,
  () => request<PeerCatalogResponse>(`catalog/${peerId.value}`),
  { watch: [peerId] },
)

const peerName = computed(() => data.value?.peer.name ?? 'Peer')
const typeFilter = ref<'all' | 'movie' | 'tv'>('all')
const titles = computed(() => {
  const all = data.value?.titles ?? []
  return typeFilter.value === 'all' ? all : all.filter(t => t.mediaType === typeFilter.value)
})

const selected = ref<CatalogTitle | null>(null)
</script>

<template>
  <UDashboardPanel id="catalog">
    <template #header>
      <UDashboardNavbar :title="peerName">
        <template #leading>
          <UButton icon="i-ph-arrow-left" color="neutral" variant="ghost" to="/settings" aria-label="Back to settings" />
        </template>
      </UDashboardNavbar>
      <UDashboardToolbar>
        <template #right>
          <UTabs
            v-model="typeFilter"
            size="sm"
            :items="[{ label: 'All', value: 'all' }, { label: 'Movies', value: 'movie' }, { label: 'TV', value: 'tv' }]"
            :content="false"
          />
        </template>
      </UDashboardToolbar>
    </template>

    <template #body>
      <UAlert v-if="error" color="error" variant="soft" icon="i-ph-warning" title="Failed to load this peer's catalog." />

      <p v-else-if="pending" class="flex items-center gap-2 text-sm text-muted">
        <UIcon name="i-ph-circle-notch" class="size-4 animate-spin" />
        Loading…
      </p>

      <UCard v-else-if="titles.length === 0" variant="subtle">
        <div class="flex flex-col items-center gap-3 py-6 text-center">
          <UIcon name="i-ph-film-slate" class="size-8 text-dimmed" />
          <p class="text-sm text-muted">
            Nothing to show here.
          </p>
        </div>
      </UCard>

      <div v-else class="grid grid-cols-3 gap-4 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 xl:grid-cols-8">
        <CatalogPosterCard
          v-for="title in titles"
          :key="title.key"
          :title="title"
          @select="selected = title"
        />
      </div>
    </template>
  </UDashboardPanel>

  <USlideover
    :open="selected !== null"
    :title="selected?.metadata?.title ?? selected?.displayTitle ?? 'Title'"
    @update:open="(open) => { if (!open) selected = null }"
  >
    <template #body>
      <CatalogTitleDetail v-if="selected" :title="selected" />
    </template>
  </USlideover>
</template>
