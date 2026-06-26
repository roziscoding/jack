<script setup lang="ts">
import type { BadgeProps, TableColumn } from '@nuxt/ui'
import type { DownloadItem } from '~/types/management'

type StatusFilter = DownloadItem['status'] | 'all'

const { request } = useManagement()

const { data, pending, error, refresh } = await useAsyncData('downloads', () =>
  request<{ downloads: DownloadItem[] }>('downloads'))

const { REFRESH_OPTIONS, intervalMs, paused, secondsLeft, togglePaused } = useAutoRefresh(refresh)

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

const columns: TableColumn<DownloadItem>[] = [
  { accessorKey: 'filename', header: 'File' },
  { accessorKey: 'peerName', header: 'Peer' },
  { accessorKey: 'status', header: 'Status' },
  { accessorKey: 'progress', header: 'Progress' },
  { accessorKey: 'totalBytes', header: 'Size' },
  { accessorKey: 'updatedAt', header: 'Updated' },
]
</script>

<template>
  <UDashboardPanel id="downloads">
    <template #header>
      <UDashboardNavbar title="Downloads">
        <template #trailing>
          <UDashboardSidebarCollapse icon="i-ph-sidebar-simple" />
        </template>
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
            @click="filter = chip.key"
          >
            {{ chip.label }}
            <UBadge :color="chip.color" :variant="filter === chip.key ? 'solid' : 'soft'" size="sm">
              {{ counts[chip.key] }}
            </UBadge>
          </UButton>
        </div>

        <UTable :data="filtered" :columns="columns" :ui="{ td: 'align-top' }">
          <template #filename-cell="{ row }">
            <div class="max-w-xs">
              <p class="truncate font-medium text-default" :title="row.original.filename">
                {{ row.original.filename }}
              </p>
              <p v-if="row.original.error" class="truncate text-xs text-error" :title="row.original.error">
                {{ row.original.error }}
              </p>
              <p v-else-if="row.original.expectedBytesMismatch" class="text-xs text-warning">
                size mismatch
              </p>
            </div>
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

          <template #empty>
            <div class="py-6 text-center text-sm text-muted">
              No {{ statusBadge[filter as DownloadItem['status']].label.toLowerCase() }} downloads.
            </div>
          </template>
        </UTable>
      </div>
    </template>
  </UDashboardPanel>
</template>
