<script setup lang="ts">
import type { PeerCatalogResponse } from '~/types/management'

const route = useRoute()
const peerId = computed(() => String(route.params.peerId))
const { request } = useManagement()

const { data, pending, error } = await useAsyncData(
  `catalog-${peerId.value}`,
  () => request<PeerCatalogResponse>(`catalog/${peerId.value}`),
  { watch: [peerId] },
)

const titles = computed(() => data.value?.titles ?? [])
const peerName = computed(() => data.value?.peer.name ?? 'Peer')
</script>

<template>
  <UDashboardPanel id="catalog">
    <template #header>
      <UDashboardNavbar :title="peerName">
        <template #leading>
          <UButton icon="i-ph-arrow-left" color="neutral" variant="ghost" to="/settings" aria-label="Back to settings" />
        </template>
      </UDashboardNavbar>
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
            This peer isn't sharing anything yet.
          </p>
        </div>
      </UCard>

      <div v-else class="space-y-2">
        <UCard v-for="title in titles" :key="title.key" variant="subtle" :ui="{ body: 'sm:p-4' }">
          <div class="flex items-center gap-3">
            <UIcon :name="title.mediaType === 'tv' ? 'i-ph-television' : 'i-ph-film-strip'" class="size-5 shrink-0 text-muted" />
            <div class="min-w-0 flex-1">
              <p class="truncate font-medium text-default" :title="title.displayTitle">
                {{ title.displayTitle }}
              </p>
              <p class="text-xs text-muted">
                {{ title.releaseCount }} release{{ title.releaseCount === 1 ? '' : 's' }} · {{ formatBytes(title.totalSize) }}
              </p>
            </div>
            <UBadge :label="title.mediaType === 'tv' ? 'TV' : 'Movie'" color="neutral" variant="subtle" size="sm" />
          </div>
        </UCard>
      </div>
    </template>
  </UDashboardPanel>
</template>
