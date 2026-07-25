<script setup lang="ts">
import type { BadgeProps, TableColumn } from '@nuxt/ui'
import type { DownloadItem } from '~/types/management'
import type { DownloadAction } from '~/utils/download-actions'

type StatusFilter = DownloadItem['status'] | 'all'

const { request, extractError } = useManagement()
const toast = useToast()

const { data, pending, error, refresh } = await useAsyncData('downloads', () =>
  request<{ downloads: DownloadItem[] }>('downloads'))

const { REFRESH_OPTIONS, intervalMs, paused, secondsLeft, togglePaused } = useAutoRefresh(refresh)

const pendingActions = ref<Record<number, DownloadAction | undefined>>({})

function confirmationFor(download: DownloadItem, action: DownloadAction): string | null {
  if (action === 'cancel')
    return `Cancel ${download.filename}? Its partial file will be kept so the transfer can be retried.`
  if (action === 'delete')
    return `Delete ${download.filename}? This removes its history and any partial or completed download artifact.`
  return null
}

async function runAction(download: DownloadItem, action: DownloadAction) {
  if (pendingActions.value[download.id])
    return
  const confirmation = confirmationFor(download, action)
  // eslint-disable-next-line no-alert -- destructive actions require confirmation
  if (confirmation && !window.confirm(confirmation))
    return

  pendingActions.value[download.id] = action
  try {
    if (action === 'delete')
      await request<{ ok: true }>(`downloads/${download.id}`, { method: 'DELETE' })
    else
      await request<{ download: DownloadItem }>(`downloads/${download.id}/${action}`, { method: 'POST' })
    toast.add({
      title: action === 'cancel' ? 'Download cancelled' : action === 'retry' ? 'Download retry started' : 'Download deleted',
      color: 'success',
    })
    await refresh()
  }
  catch (actionError) {
    toast.add({
      title: `Failed to ${action} download`,
      description: extractError(actionError),
      color: 'error',
    })
  }
  finally {
    delete pendingActions.value[download.id]
  }
}

const statusBadge: Record<DownloadItem['status'], { color: BadgeProps['color'], label: string }> = {
  downloading: { color: 'primary', label: 'Downloading' },
  import_queued: { color: 'warning', label: 'Import queued' },
  imported: { color: 'success', label: 'Imported' },
  failed: { color: 'error', label: 'Failed' },
}

// Filter chips double as the at-a-glance status breakdown; counts come straight
// from the loaded list so they stay in sync with whatever's on screen.
const filter = ref<StatusFilter>('all')
const counts = computed(() => {
  const all = data.value?.downloads ?? []
  return {
    all: all.length,
    downloading: all.filter(d => d.status === 'downloading').length,
    import_queued: all.filter(d => d.status === 'import_queued').length,
    imported: all.filter(d => d.status === 'imported').length,
    failed: all.filter(d => d.status === 'failed').length,
  }
})
const chips = computed<{ key: StatusFilter, label: string, color: BadgeProps['color'] }[]>(() => [
  { key: 'all', label: 'All', color: 'neutral' },
  { key: 'downloading', label: 'Downloading', color: 'primary' },
  { key: 'import_queued', label: 'Import queued', color: 'warning' },
  { key: 'imported', label: 'Imported', color: 'success' },
  { key: 'failed', label: 'Failed', color: 'error' },
])
const filtered = computed(() => {
  const all = data.value?.downloads ?? []
  return filter.value === 'all' ? all : all.filter(d => d.status === filter.value)
})

// Client-side pagination: just slice the filtered list. No server round-trips.
const PAGE_SIZE = 10
const page = ref(1)
const total = computed(() => filtered.value.length)
const pageCount = computed(() => Math.max(1, Math.ceil(total.value / PAGE_SIZE)))
const paged = computed(() => filtered.value.slice((page.value - 1) * PAGE_SIZE, page.value * PAGE_SIZE))
const showingFrom = computed(() => (total.value === 0 ? 0 : (page.value - 1) * PAGE_SIZE + 1))
const showingTo = computed(() => Math.min(page.value * PAGE_SIZE, total.value))

// Switching filters starts over at page one; a refresh that shrinks the list
// clamps the current page so we never strand the user on an empty page.
watch(filter, () => {
  page.value = 1
})
watch(pageCount, (count) => {
  if (page.value > count)
    page.value = count
})

const columns: TableColumn<DownloadItem>[] = [
  { accessorKey: 'filename', header: 'File' },
  { accessorKey: 'peerName', header: 'Peer' },
  { accessorKey: 'status', header: 'Status' },
  { accessorKey: 'progress', header: 'Progress' },
  { accessorKey: 'totalBytes', header: 'Size' },
  { accessorKey: 'updatedAt', header: 'Updated' },
  { id: 'actions', header: '' },
]
</script>

<template>
  <UDashboardPanel id="downloads">
    <template #header>
      <UDashboardNavbar title="Downloads">
        <template #right>
          <RefreshControls
            v-model:interval-ms="intervalMs"
            :options="REFRESH_OPTIONS"
            :paused="paused"
            :seconds-left="secondsLeft"
            @toggle="togglePaused"
          />
        </template>
      </UDashboardNavbar>
    </template>

    <template #body>
      <UAlert v-if="error" color="error" variant="soft" icon="i-ph-warning" title="Failed to load downloads." />

      <p v-else-if="pending && !data" class="flex items-center gap-2 text-sm text-muted">
        <UIcon name="i-ph-circle-notch" class="size-4 animate-spin" />
        Loading…
      </p>

      <UCard v-else-if="data && data.downloads.length === 0" variant="subtle">
        <div class="flex flex-col items-center gap-3 py-6 text-center">
          <UIcon name="i-ph-download-simple" class="size-8 text-dimmed" />
          <p class="text-sm text-muted">
            No downloads yet. Transfers show up here once a peer release starts pulling.
          </p>
        </div>
      </UCard>

      <div v-else-if="data" class="space-y-4">
        <!-- Status filter / breakdown -->
        <div class="flex flex-wrap gap-2">
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
        </div>

        <!-- Desktop: the full table. -->
        <UCard class="hidden lg:block" variant="subtle" :ui="{ body: '!p-0' }">
          <UTable :data="paged" :columns="columns" :ui="{ td: 'align-top' }">
            <template #filename-cell="{ row }">
              <p class="font-medium text-default" :title="row.original.filename">
                {{ row.original.filename }}
              </p>
              <p v-if="row.original.error" class="text-xs text-error" :title="row.original.error">
                {{ row.original.error }}
              </p>
              <p v-else-if="row.original.expectedBytesMismatch" class="text-xs text-warning">
                size mismatch
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
                <ProgressBar :value="row.original.progress" />
              </div>
            </template>

            <template #totalBytes-cell="{ row }">
              <span class="tabular-nums text-muted">{{ formatBytes(row.original.totalBytes) }}</span>
            </template>

            <template #updatedAt-cell="{ row }">
              <span class="text-xs tabular-nums text-muted" :title="formatDate(row.original.updatedAt)">
                {{ formatAgo(row.original.updatedAt) }} ago
              </span>
            </template>

            <template #actions-cell="{ row }">
              <DownloadActions
                :download="row.original"
                :pending="pendingActions[row.original.id]"
                @action="runAction(row.original, $event)"
              />
            </template>

            <template #empty>
              <div class="py-6 text-center text-sm text-muted">
                No {{ statusBadge[filter as DownloadItem['status']].label.toLowerCase() }} downloads.
              </div>
            </template>
          </UTable>
        </UCard>

        <!-- Mobile: a card per download — a 6-column table is unusable on a phone. -->
        <div class="space-y-2 lg:hidden">
          <UCard v-for="d in paged" :key="d.id" variant="subtle" :ui="{ body: 'p-3' }">
            <div class="space-y-2.5">
              <div class="flex items-start justify-between gap-3">
                <div class="min-w-0">
                  <p class="font-medium break-words text-default" :title="d.filename">
                    {{ d.filename }}
                  </p>
                  <p v-if="d.error" class="mt-0.5 text-xs text-error">
                    {{ d.error }}
                  </p>
                  <p v-else-if="d.expectedBytesMismatch" class="mt-0.5 text-xs text-warning">
                    size mismatch
                  </p>
                </div>
                <UBadge v-bind="statusBadge[d.status]" variant="subtle" class="shrink-0" />
              </div>
              <ProgressBar :value="d.progress" />
              <div class="flex items-center justify-between gap-2 text-xs text-muted">
                <span class="truncate">{{ d.peerName }}</span>
                <span class="shrink-0 tabular-nums">{{ formatBytes(d.totalBytes) }} · {{ formatAgo(d.updatedAt) }} ago</span>
              </div>
              <DownloadActions
                :download="d"
                :pending="pendingActions[d.id]"
                @action="runAction(d, $event)"
              />
            </div>
          </UCard>

          <p v-if="paged.length === 0" class="py-6 text-center text-sm text-muted">
            No {{ statusBadge[filter as DownloadItem['status']].label.toLowerCase() }} downloads.
          </p>
        </div>

        <!-- Pagination shared by both layouts. -->
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
