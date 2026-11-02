<script setup lang="ts">
import type { CatalogRequestPayload, CatalogResponse, CatalogTitle } from '~/types/management'

const { request, extractError } = useManagement()
const { entryFor } = useCatalogMetadata()
const toast = useToast()

// Distinct, view-consistent peer colors from the shared settings store. Provided so
// the poster badges and detail cards resolve the same color for a given peer.
const { settings } = useSettings()
providePeerColors(computed(() => settings.value?.peerColors ?? new Map()))

const typeFilter = useQueryString<'all' | 'movie' | 'tv'>('type', 'all')
const search = useQueryString('q', '')
const peerFilter = useQueryString('peer', [])
const genreFilter = useQueryString('genre', [])
const hideOwned = useQueryString('hideOwned', false)

// Typing in the search box shouldn't fire a request per keystroke.
const QUERY_DEBOUNCE_MS = 250

function queryParams() {
  return {
    q: search.value.trim() || undefined,
    type: typeFilter.value === 'all'
      ? undefined
      : typeFilter.value,
    peer: peerFilter.value,
    genre: genreFilter.value,
    hideOwned: hideOwned.value
      ? 'true'
      : undefined,
  }
}

const params = ref(queryParams())
let debounce: ReturnType<typeof setTimeout> | undefined
watch(() => JSON.stringify(queryParams()), () => {
  clearTimeout(debounce)
  debounce = setTimeout(() => params.value = queryParams(), QUERY_DEBOUNCE_MS)
})
onBeforeUnmount(() => clearTimeout(debounce))

// The backend searches, filters, and sorts the cached catalog, so every query is
// a quick read; peers are only contacted by the scheduled sync and Update.
const { data, pending, error, refresh } = useLazyAsyncData(
  'peer-catalog',
  () => request<CatalogResponse>('catalog', { query: params.value }),
  {
    watch: [params],
  },
)

const titles = computed(() => data.value?.titles ?? [])
const facets = computed(() => data.value?.facets)
// Skeletons only until the first answer; later queries keep the grid in place.
const loading = computed(() => pending.value && !data.value)

const syncing = ref(false)
const syncedAt = computed(() => data.value?.sync.syncedAt ?? null)
const syncBusy = computed(() => syncing.value || !!data.value?.sync.syncing)

async function update() {
  syncing.value = true
  try {
    await request('catalog/refresh', { method: 'POST' })
    await refresh()
  }
  catch (err) {
    toast.add({
      title: 'Could not update the catalog',
      description: extractError(err, 'The sync failed.'),
      color: 'error',
      icon: 'i-ph-warning',
    })
  }
  finally {
    syncing.value = false
  }
}

// A sync already running on the server (at boot, or on schedule) shows up here;
// check back until it's done so its results appear without a reload.
let syncPoll: ReturnType<typeof setTimeout> | undefined
watch(() => data.value?.sync.syncing, (running) => {
  clearTimeout(syncPoll)
  if (running && !syncing.value)
    syncPoll = setTimeout(refresh, 5000)
})
onBeforeUnmount(() => clearTimeout(syncPoll))

function titleName(title: CatalogTitle): string {
  return entryFor(title)?.data?.title ?? title.metadata?.title ?? title.displayTitle
}

const typeItems = computed(() => [
  { label: 'All types', value: 'all' as const, count: facets.value?.types.all },
  { label: 'Movies', value: 'movie' as const, count: facets.value?.types.movie },
  { label: 'TV', value: 'tv' as const, count: facets.value?.types.tv },
])

const peerItems = computed(() => (data.value?.peers ?? []).map(p => ({
  label: p.name,
  value: p.id,
  count: facets.value?.peers[p.id] ?? 0,
})))

const genreItems = computed(() => (facets.value?.genres ?? []).map(({ genre, count }) => ({
  label: genre,
  value: genre,
  count,
})))

const ownedCount = computed(() => facets.value?.owned ?? 0)

const hasFilters = computed(() =>
  search.value.trim() !== ''
  || typeFilter.value !== 'all'
  || peerFilter.value.length > 0
  || genreFilter.value.length > 0
  || hideOwned.value)
const catalogEmpty = computed(() => (facets.value?.types.all ?? 0) === 0)

function clearFilters() {
  search.value = ''
  typeFilter.value = 'all'
  peerFilter.value = []
  genreFilter.value = []
  hideOwned.value = false
}

// inject() can't see this component's own provide, so resolve the dot directly.
function dotClass(peerId: string): string {
  return settings.value?.peerColors.get(peerId)?.dot ?? peerColorClass(peerId)
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
          <span v-if="syncBusy" class="hidden text-xs text-muted sm:inline">Updating from peers…</span>
          <UTooltip v-else-if="syncedAt" :text="formatDate(syncedAt)">
            <span class="hidden text-xs text-muted sm:inline">Updated {{ formatAgo(syncedAt) }} ago</span>
          </UTooltip>
          <UButton
            label="Update"
            icon="i-ph-arrows-clockwise"
            color="neutral"
            variant="subtle"
            size="sm"
            :loading="syncBusy"
            @click="update"
          />
        </template>
      </UDashboardNavbar>

      <UDashboardToolbar :ui="{ root: 'px-4 sm:px-8 py-2 gap-2 flex-wrap', left: 'w-full flex-wrap gap-1.5 sm:w-auto', right: 'gap-3' }">
        <template #left>
          <UInput
            v-model="search"
            icon="i-ph-magnifying-glass"
            placeholder="Search titles"
            size="sm"
            class="w-full sm:w-56"
            aria-label="Search titles"
          />

          <USelectMenu
            v-model="typeFilter"
            :items="typeItems"
            value-key="value"
            icon="i-ph-film-strip"
            size="sm"
            :search-input="false"
            class="w-[calc(33.333%-0.25rem)] sm:w-32"
            aria-label="Filter by type"
          >
            <template #item-trailing="{ item }">
              <span class="text-xs tabular-nums text-dimmed">{{ item.count }}</span>
            </template>
          </USelectMenu>

          <USelectMenu
            v-model="peerFilter"
            :items="peerItems"
            value-key="value"
            multiple
            icon="i-ph-users-three"
            size="sm"
            :search-input="{ placeholder: 'Find a peer' }"
            class="w-[calc(33.333%-0.25rem)] sm:w-32"
            aria-label="Filter by peer"
          >
            <template #default>
              <span class="flex items-center gap-1.5">
                <span :class="peerFilter.length ? 'text-default' : 'text-dimmed'">Peer</span>
                <UBadge v-if="peerFilter.length" :label="String(peerFilter.length)" color="primary" variant="soft" size="sm" />
              </span>
            </template>
            <template #item-leading="{ item }">
              <span class="size-2 shrink-0 rounded-full" :class="dotClass(item.value)" />
            </template>
            <template #item-trailing="{ item }">
              <span class="text-xs tabular-nums text-dimmed">{{ item.count }}</span>
            </template>
          </USelectMenu>

          <USelectMenu
            v-model="genreFilter"
            :items="genreItems"
            value-key="value"
            multiple
            icon="i-ph-tag"
            size="sm"
            :search-input="{ placeholder: 'Find a genre' }"
            :disabled="genreItems.length === 0"
            :ui="{ content: 'min-w-48' }"
            class="w-[calc(33.333%-0.25rem)] sm:w-32"
            aria-label="Filter by genre"
          >
            <template #default>
              <span class="flex items-center gap-1.5">
                <span :class="genreFilter.length ? 'text-default' : 'text-dimmed'">Genre</span>
                <UBadge v-if="genreFilter.length" :label="String(genreFilter.length)" color="primary" variant="soft" size="sm" />
              </span>
            </template>
            <template #item-trailing="{ item }">
              <span class="text-xs tabular-nums text-dimmed">{{ item.count }}</span>
            </template>
          </USelectMenu>

          <UButton
            v-if="hasFilters"
            label="Clear filters"
            icon="i-ph-x"
            color="neutral"
            variant="ghost"
            size="sm"
            @click="clearFilters"
          />
        </template>
        <template #right>
          <USwitch
            v-model="hideOwned"
            :label="`Hide titles I have (${ownedCount})`"
            :disabled="!hideOwned && ownedCount === 0"
            size="sm"
          />
        </template>
      </UDashboardToolbar>
    </template>

    <template #body>
      <UAlert v-if="error" color="error" variant="soft" icon="i-ph-warning" title="Failed to load the peer catalog." />

      <UCard v-else-if="!loading && catalogEmpty" variant="subtle">
        <div class="flex flex-col items-center gap-3 py-6 text-center">
          <UIcon name="i-ph-film-slate" class="size-8 text-dimmed" />
          <p class="text-sm text-muted">
            {{ syncBusy
              ? 'Fetching your peers\' catalogs. Titles show up here once they answer.'
              : 'Your peers aren\'t sharing any titles yet.' }}
          </p>
          <UButton v-if="!syncBusy" label="Update" icon="i-ph-arrows-clockwise" color="neutral" variant="subtle" size="sm" @click="update" />
        </div>
      </UCard>

      <UCard v-else-if="!loading && titles.length === 0" variant="subtle">
        <div class="flex flex-col items-center gap-3 py-6 text-center">
          <UIcon name="i-ph-funnel-x" class="size-8 text-dimmed" />
          <p class="text-sm text-muted">
            No titles match these filters.
          </p>
          <UButton v-if="hasFilters" label="Clear filters" color="neutral" variant="subtle" size="sm" @click="clearFilters" />
        </div>
      </UCard>

      <div
        v-else
        class="grid grid-cols-[repeat(auto-fill,minmax(120px,1fr))] gap-4 sm:grid-cols-[repeat(auto-fill,minmax(140px,1fr))] md:grid-cols-[repeat(auto-fill,minmax(160px,1fr))] lg:grid-cols-[repeat(auto-fill,minmax(180px,1fr))] xl:grid-cols-[repeat(auto-fill,minmax(200px,1fr))]"
      >
        <template v-if="loading">
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
