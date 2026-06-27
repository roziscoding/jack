<script setup lang="ts">
import type { CatalogRequestPayload, CatalogTitle, PeerCatalogResponse } from '~/types/management'

const route = useRoute()
const peerId = computed(() => String(route.params.peerId))
const { request, extractError } = useManagement()
const { entryFor } = useCatalogMetadata()
const toast = useToast()

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

// Paginate so only the current page's cards mount — that bounds how many TMDB
// lookups fire at once (each card fetches its own metadata on mount).
const PAGE_SIZE = 48
const page = ref(1)
const pagedTitles = computed(() => titles.value.slice((page.value - 1) * PAGE_SIZE, page.value * PAGE_SIZE))
// Jump back to the first page whenever the filter narrows the list.
watch(typeFilter, () => {
  page.value = 1
})

function titleName(title: CatalogTitle): string {
  return entryFor(title)?.data?.title ?? title.metadata?.title ?? title.displayTitle
}

const selected = ref<CatalogTitle | null>(null)

const requestOpen = ref(false)
const requestTitle = ref<CatalogTitle | null>(null)
const requestSubmitting = ref(false)
const requestError = ref<string | null>(null)

function openRequest() {
  requestTitle.value = selected.value
  requestError.value = null
  requestOpen.value = true
}

async function onConfirm(payload: CatalogRequestPayload) {
  const title = requestTitle.value
  if (!title)
    return
  requestSubmitting.value = true
  requestError.value = null
  try {
    await request('catalog/request', {
      method: 'POST',
      body: {
        ...payload,
        mediaType: title.mediaType,
        tmdbId: title.tmdbId,
        tvdbId: title.tvdbId,
      },
    })
    requestOpen.value = false
    selected.value = null
    toast.add({
      title: 'Added to your library',
      description: `"${titleName(title)}" is being searched by your *arr.`,
      color: 'success',
      icon: 'i-ph-check-circle',
    })
  }
  catch (err) {
    requestError.value = extractError(err, 'Could not request this title.')
  }
  finally {
    requestSubmitting.value = false
  }
}
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

      <template v-else>
        <div class="grid grid-cols-3 gap-4 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 xl:grid-cols-8">
          <CatalogPosterCard
            v-for="title in pagedTitles"
            :key="title.key"
            :title="title"
            @select="selected = title"
          />
        </div>

        <div v-if="titles.length > PAGE_SIZE" class="mt-6 flex justify-center">
          <UPagination v-model:page="page" :total="titles.length" :items-per-page="PAGE_SIZE" />
        </div>
      </template>
    </template>
  </UDashboardPanel>

  <USlideover
    :open="selected !== null"
    :title="selected ? titleName(selected) : 'Title'"
    @update:open="(open) => { if (!open) selected = null }"
  >
    <template #body>
      <CatalogTitleDetail v-if="selected" :title="selected" @download="openRequest" />
    </template>
  </USlideover>

  <DownloadRequestModal
    v-model:open="requestOpen"
    :title="requestTitle"
    :submitting="requestSubmitting"
    :error="requestError"
    @confirm="onConfirm"
  />
</template>
