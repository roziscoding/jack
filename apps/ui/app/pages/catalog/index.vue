<script setup lang="ts">
import type { CatalogRequestPayload, CatalogResponse, CatalogTitle } from '~/types/management'

const { request, extractError } = useManagement()
const { entryFor } = useCatalogMetadata()
const toast = useToast()

// Lazy (no top-level await) so navigation into the page is instant; the grid shows
// skeletons until the catalog request resolves.
const { data, pending, error } = useLazyAsyncData(
  'peer-catalog',
  () => request<CatalogResponse>('catalog'),
)

// Distinct, view-consistent peer colors from the shared settings store. Provided so
// the poster badges and detail cards resolve the same color for a given peer.
const { settings } = useSettings()
providePeerColors(computed(() => settings.value?.peerColors ?? new Map()))

const typeFilter = ref<'all' | 'movie' | 'tv'>('all')
const titles = computed(() => {
  const all = data.value?.titles ?? []
  return typeFilter.value === 'all' ? all : all.filter(t => t.mediaType === typeFilter.value)
})

function titleName(title: CatalogTitle): string {
  return entryFor(title)?.data?.title ?? title.metadata?.title ?? title.displayTitle
}

const selected = ref<CatalogTitle | null>(null)

const requestOpen = ref(false)
const requestTitle = ref<CatalogTitle | null>(null)
const requestPeerId = ref<string | undefined>(undefined)
const requestSubmitting = ref(false)
const requestError = ref<string | null>(null)

function openRequest(peerId: string) {
  requestTitle.value = selected.value
  requestPeerId.value = peerId
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
    const peerName = title.peers.find(p => p.id === payload.peerId)?.name ?? 'a peer'
    toast.add({
      title: 'Added to your library',
      description: `"${titleName(title)}" is downloading from ${peerName}.`,
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
      <UDashboardNavbar title="Peer Catalog">
        <template #right>
          <UTabs
            v-model="typeFilter"
            size="sm"
            :items="[{ label: 'All', value: 'all' }, { label: 'Movies', value: 'movie' }, { label: 'TV', value: 'tv' }]"
            :content="false"
          />
        </template>
      </UDashboardNavbar>
    </template>

    <template #body>
      <UAlert v-if="error" color="error" variant="soft" icon="i-ph-warning" title="Failed to load the peer catalog." />

      <UCard v-else-if="!pending && titles.length === 0" variant="subtle">
        <div class="flex flex-col items-center gap-3 py-6 text-center">
          <UIcon name="i-ph-film-slate" class="size-8 text-dimmed" />
          <p class="text-sm text-muted">
            Nothing to show here.
          </p>
        </div>
      </UCard>

      <div
        v-else
        class="grid grid-cols-[repeat(auto-fill,minmax(120px,1fr))] gap-4 sm:grid-cols-[repeat(auto-fill,minmax(140px,1fr))] md:grid-cols-[repeat(auto-fill,minmax(160px,1fr))] lg:grid-cols-[repeat(auto-fill,minmax(180px,1fr))] xl:grid-cols-[repeat(auto-fill,minmax(200px,1fr))]"
      >
        <template v-if="pending">
          <CatalogPosterCardSkeleton v-for="n in 18" :key="n" />
        </template>
        <CatalogPosterCard
          v-for="title in titles"
          v-else
          :key="title.key"
          :title="title"
          @select="selected = title"
        />
      </div>
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
    :locked-peer-id="requestPeerId"
    :submitting="requestSubmitting"
    :error="requestError"
    @confirm="onConfirm"
  />
</template>
