<script setup lang="ts">
import type { BadgeProps, TableColumn } from '@nuxt/ui'
import type { UploadItem } from '~/types/management'

type StatusFilter = UploadItem['status'] | 'all'

const { request } = useManagement()

const { data, pending, error } = await useAsyncData('uploads', () =>
  request<{ uploads: UploadItem[] }>('uploads'))

const { connected } = useManagementStream<{ uploads: UploadItem[] }>('uploads/stream', (snapshot) => {
  data.value = snapshot
})

const statusBadge: Record<UploadItem['status'], { color: BadgeProps['color'], label: string }> = {
  uploading: { color: 'primary', label: 'Uploading' },
  completed: { color: 'success', label: 'Completed' },
  aborted: { color: 'warning', label: 'Aborted' },
  unconfirmed: { color: 'neutral', label: 'Unconfirmed' },
}

// Files go out zero-copy, so speed is the average the downloading jack reports
// once it has the file. There is no live speed while a file is being sent.
function speedLabel(upload: UploadItem): string {
  if (upload.speedBps != null && upload.durationMs != null)
    return `${formatBytes(upload.speedBps)}/s average · ${formatDurationMs(upload.durationMs)}`
  if (upload.status === 'uploading')
    return 'Sending…'
  if (upload.status === 'unconfirmed')
    return 'Speed unknown'
  return ''
}

// Filter chips double as the at-a-glance status breakdown.
const filter = ref<StatusFilter>('all')
const counts = computed(() => {
  const all = data.value?.uploads ?? []
  return {
    all: all.length,
    uploading: all.filter(u => u.status === 'uploading').length,
    completed: all.filter(u => u.status === 'completed').length,
    aborted: all.filter(u => u.status === 'aborted').length,
    unconfirmed: all.filter(u => u.status === 'unconfirmed').length,
  }
})
const chips: { key: StatusFilter, label: string, color: BadgeProps['color'] }[] = [
  { key: 'all', label: 'All', color: 'neutral' },
  { key: 'uploading', label: 'Uploading', color: 'primary' },
  { key: 'completed', label: 'Completed', color: 'success' },
  { key: 'aborted', label: 'Aborted', color: 'warning' },
  { key: 'unconfirmed', label: 'Unconfirmed', color: 'neutral' },
]

const search = ref('')
const peerFilter = ref<string[]>([])

const peerItems = computed(() => {
  const counts = new Map<string, number>()
  for (const u of data.value?.uploads ?? [])
    counts.set(u.peerName, (counts.get(u.peerName) ?? 0) + 1)
  return Array.from(counts, ([peer, count]) => ({ label: peer, value: peer, count }))
    .sort((a, b) => a.label.localeCompare(b.label))
})

// Drop selected peers that no longer appear after a live update. Only reassign
// when something was dropped, so updates don't reset the page.
watch(peerItems, (items) => {
  const present = new Set(items.map(item => item.value))
  const kept = peerFilter.value.filter(value => present.has(value))
  if (kept.length !== peerFilter.value.length)
    peerFilter.value = kept
})

const hasFilters = computed(() => filter.value !== 'all' || search.value.trim() !== '' || peerFilter.value.length > 0)
const emptyMessage = computed(() => {
  const onlyStatus = search.value.trim() === '' && peerFilter.value.length === 0
  if (onlyStatus && filter.value !== 'all')
    return `No ${statusBadge[filter.value].label.toLowerCase()} uploads.`
  return 'No uploads match these filters.'
})

function clearFilters() {
  filter.value = 'all'
  search.value = ''
  peerFilter.value = []
}

const filtered = computed(() => (data.value?.uploads ?? []).filter(u =>
  (filter.value === 'all' || u.status === filter.value)
  && matchesSearch(u.filename, search.value)
  && (peerFilter.value.length === 0 || peerFilter.value.includes(u.peerName))))

// Client-side pagination over the filtered list.
const PAGE_SIZE = 10
const page = ref(1)
const total = computed(() => filtered.value.length)
const pageCount = computed(() => Math.max(1, Math.ceil(total.value / PAGE_SIZE)))
const paged = computed(() => filtered.value.slice((page.value - 1) * PAGE_SIZE, page.value * PAGE_SIZE))
const showingFrom = computed(() => (total.value === 0
  ? 0
  : (page.value - 1) * PAGE_SIZE + 1))
const showingTo = computed(() => Math.min(page.value * PAGE_SIZE, total.value))

watch([filter, search, peerFilter], () => {
  page.value = 1
})
watch(pageCount, (count) => {
  if (page.value > count)
    page.value = count
})

const columns: TableColumn<UploadItem>[] = [
  {
    accessorKey: 'filename',
    header: 'File',
    meta: {
      class: { td: 'min-w-64 whitespace-normal' },
    },
  },
  { accessorKey: 'peerName', header: 'Peer' },
  { accessorKey: 'status', header: 'Status' },
  { accessorKey: 'progress', header: 'Progress' },
  { accessorKey: 'sentBytes', header: 'Sent' },
  { accessorKey: 'totalBytes', header: 'Size' },
  { accessorKey: 'startedAt', header: 'Started' },
  { accessorKey: 'finishedAt', header: 'Finished' },
]
</script>

<template>
  <UDashboardPanel id="uploads">
    <template #header>
      <UDashboardNavbar title="Uploads">
        <template #right>
          <UBadge :color="connected ? 'success' : 'warning'" variant="subtle" icon="i-ph-broadcast">
            {{ connected ? 'Live' : 'Reconnecting…' }}
          </UBadge>
        </template>
      </UDashboardNavbar>

      <UDashboardToolbar
        v-if="data?.uploads.length"
        :ui="{ root: 'flex-wrap overflow-visible gap-y-2 py-2', left: 'flex-wrap', right: 'flex-wrap w-full sm:w-auto' }"
      >
        <template #left>
          <UButton
            v-for="chip in chips"
            :key="chip.key"
            :color="chip.color"
            :variant="filter === chip.key ? 'subtle' : 'ghost'"
            size="sm"
            @click="() => { filter = chip.key }"
          >
            {{ chip.label }}
            <UBadge :color="chip.color" :variant="filter === chip.key ? 'solid' : 'soft'" size="sm">
              {{ counts[chip.key] }}
            </UBadge>
          </UButton>
        </template>

        <template #right>
          <UInput
            v-model="search"
            icon="i-ph-magnifying-glass"
            placeholder="Search by file name"
            size="sm"
            class="w-full sm:w-56"
            aria-label="Search uploads by file name"
          />

          <USelectMenu
            v-model="peerFilter"
            :items="peerItems"
            value-key="value"
            multiple
            icon="i-ph-users-three"
            size="sm"
            :search-input="{ placeholder: 'Find a peer' }"
            class="w-[calc(50%-0.1875rem)] sm:w-36"
            aria-label="Filter by peer"
          >
            <template #default>
              <span class="flex items-center gap-1.5">
                <span :class="peerFilter.length ? 'text-default' : 'text-dimmed'">Peer</span>
                <UBadge v-if="peerFilter.length" :label="String(peerFilter.length)" color="primary" variant="soft" size="sm" />
              </span>
            </template>
            <template #item-trailing="{ item }">
              <span class="text-xs tabular-nums text-dimmed">{{ (item as { count?: number }).count }}</span>
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
      </UDashboardToolbar>
    </template>

    <template #body>
      <UAlert v-if="error" color="error" variant="soft" icon="i-ph-warning" title="Failed to load uploads." />

      <p v-else-if="pending && !data" class="flex items-center gap-2 text-sm text-muted">
        <UIcon name="i-ph-circle-notch" class="size-4 animate-spin" />
        Loading…
      </p>

      <UCard v-else-if="data && data.uploads.length === 0" variant="subtle">
        <div class="flex flex-col items-center gap-3 py-6 text-center">
          <UIcon name="i-ph-upload-simple" class="size-8 text-dimmed" />
          <p class="text-sm text-muted">
            No uploads yet. Files show up here once a peer starts pulling from your library.
          </p>
        </div>
      </UCard>

      <div v-else-if="data" class="space-y-4">
        <!-- Desktop: the full table. -->
        <UCard class="hidden lg:block" variant="subtle" :ui="{ body: '!p-0' }">
          <UTable
            :data="paged"
            :columns="columns"
            :get-row-id="(upload: UploadItem) => String(upload.id)"
            :ui="{ td: 'align-top' }"
          >
            <template #filename-cell="{ row }">
              <p class="font-medium wrap-anywhere text-default" :title="row.original.filename">
                {{ row.original.filename }}
              </p>
              <p v-if="row.original.rangeStart > 0" class="text-xs text-muted">
                resumed at {{ formatBytes(row.original.rangeStart) }}
              </p>
              <p v-if="row.original.error" class="text-xs text-warning">
                {{ row.original.error }}
              </p>
            </template>

            <template #peerName-cell="{ row }">
              <span class="text-muted">{{ row.original.peerName }}</span>
            </template>

            <template #status-cell="{ row }">
              <UBadge v-bind="statusBadge[row.original.status]" variant="subtle" />
            </template>

            <template #progress-cell="{ row }">
              <div class="w-44">
                <ProgressBar v-if="row.original.progress != null" :value="row.original.progress" />
                <p v-if="speedLabel(row.original)" class="mt-1 text-xs tabular-nums text-muted">
                  {{ speedLabel(row.original) }}
                </p>
              </div>
            </template>

            <template #sentBytes-cell="{ row }">
              <span class="tabular-nums text-muted">{{ row.original.status === 'completed' ? formatBytes(row.original.sentBytes) : '—' }}</span>
            </template>

            <template #totalBytes-cell="{ row }">
              <span class="tabular-nums text-muted">{{ formatBytes(row.original.totalBytes) }}</span>
            </template>

            <template #startedAt-cell="{ row }">
              <span class="text-xs tabular-nums text-muted" :title="formatDate(row.original.startedAt)">
                {{ formatAgo(row.original.startedAt) }} ago
              </span>
            </template>

            <template #finishedAt-cell="{ row }">
              <span v-if="row.original.finishedAt" class="text-xs tabular-nums text-muted" :title="formatDate(row.original.finishedAt)">
                {{ formatAgo(row.original.finishedAt) }} ago
              </span>
              <span v-else class="text-xs text-dimmed">—</span>
            </template>

            <template #empty>
              <div class="flex flex-col items-center gap-2 py-6 text-sm text-muted">
                <p>{{ emptyMessage }}</p>
                <UButton label="Clear filters" color="neutral" variant="subtle" size="sm" @click="clearFilters" />
              </div>
            </template>
          </UTable>
        </UCard>

        <!-- Mobile: a card per upload. -->
        <div class="space-y-2 lg:hidden">
          <UCard v-for="u in paged" :key="u.id" variant="subtle" :ui="{ body: 'p-3' }">
            <div class="space-y-2.5">
              <div class="flex items-start justify-between gap-3">
                <div class="min-w-0 flex-1">
                  <p class="font-medium break-words text-default" :title="u.filename">
                    {{ u.filename }}
                  </p>
                  <p v-if="u.error" class="mt-0.5 text-xs text-warning">
                    {{ u.error }}
                  </p>
                </div>
                <UBadge v-bind="statusBadge[u.status]" variant="subtle" class="shrink-0" />
              </div>
              <ProgressBar v-if="u.progress != null" :value="u.progress" />
              <p v-if="speedLabel(u)" class="text-xs tabular-nums text-muted">
                {{ speedLabel(u) }}
              </p>
              <div class="flex items-center justify-between gap-2 text-xs text-muted">
                <span class="truncate">{{ u.peerName }}</span>
                <span class="shrink-0 tabular-nums">{{ formatBytes(u.requestedBytes) }} of {{ formatBytes(u.totalBytes) }} · {{ formatAgo(u.startedAt) }} ago</span>
              </div>
            </div>
          </UCard>

          <div v-if="paged.length === 0" class="flex flex-col items-center gap-2 py-6 text-sm text-muted">
            <p>{{ emptyMessage }}</p>
            <UButton label="Clear filters" color="neutral" variant="subtle" size="sm" @click="clearFilters" />
          </div>
        </div>

        <div v-if="total > 0" class="flex items-center justify-between gap-4">
          <p class="text-xs tabular-nums text-muted">
            Showing {{ showingFrom }}–{{ showingTo }} of {{ total }}
          </p>
          <UPagination
            v-if="pageCount > 1"
            v-model:page="page"
            :total="total"
            :items-per-page="PAGE_SIZE"
            :sibling-count="1"
            size="sm"
          />
        </div>
      </div>
    </template>
  </UDashboardPanel>
</template>
