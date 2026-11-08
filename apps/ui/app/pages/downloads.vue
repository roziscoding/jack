<script setup lang="ts">
import type { BadgeProps, TableColumn } from '@nuxt/ui'
import type { DownloadItem } from '~/types/management'
import type { DownloadAction } from '~/utils/download-actions'

type StatusFilter = DownloadItem['status'] | 'all'

const { request, extractError } = useManagement()
const toast = useToast()

const { data, pending, error, refresh } = await useAsyncData('downloads', () =>
  request<{ downloads: DownloadItem[] }>('downloads'))

const { connected } = useManagementStream<{ downloads: DownloadItem[] }>('downloads/stream', (snapshot) => {
  data.value = snapshot
})

const pendingActions = ref<Record<number, DownloadAction | undefined>>({})

function confirmationFor(download: DownloadItem, action: DownloadAction): string | null {
  if (action === 'cancel')
    return `Cancel ${download.filename}? Its partial file will be kept so the transfer can be retried.`
  if (action === 'delete')
    return `Delete ${download.filename}? This removes its history and any partial or completed download artifact.`
  return null
}

async function sendAction(download: DownloadItem, action: DownloadAction) {
  if (action === 'delete')
    await request<{ ok: true }>(`downloads/${download.id}`, { method: 'DELETE' })
  else
    await request<{ download: DownloadItem }>(`downloads/${download.id}/${action}`, { method: 'POST' })
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
    await sendAction(download, action)
    toast.add({
      title: action === 'cancel'
        ? 'Download cancelled'
        : action === 'retry'
          ? 'Download retry started'
          : 'Download deleted',
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

// Row selection for bulk actions, keyed by download id (see get-row-id) so it
// survives live updates and paging.
const rowSelection = ref<Record<string, boolean>>({})
const selected = computed(() => (data.value?.downloads ?? []).filter(d => rowSelection.value[String(d.id)]))
const bulkPending = ref<DownloadAction>()

const BULK_ACTIONS: { action: DownloadAction, label: string, done: string, icon: string, color: 'neutral' | 'error' | 'primary' }[] = [
  {
    action: 'retry',
    label: 'Retry',
    done: 'Retry started for',
    icon: 'i-ph-arrow-clockwise',
    color: 'primary',
  },
  {
    action: 'cancel',
    label: 'Cancel',
    done: 'Cancelled',
    icon: 'i-ph-x-circle',
    color: 'neutral',
  },
  {
    action: 'delete',
    label: 'Delete',
    done: 'Deleted',
    icon: 'i-ph-trash',
    color: 'error',
  },
]

function pluralDownloads(count: number): string {
  return count === 1
    ? '1 download'
    : `${count} downloads`
}

// Each action only applies to the selected rows that support it.
function eligibleFor(action: DownloadAction): DownloadItem[] {
  return selected.value.filter(d => downloadActionsFor(d).includes(action))
}

function toggleSelected(download: DownloadItem, value: boolean | 'indeterminate') {
  rowSelection.value = { ...rowSelection.value, [String(download.id)]: value === true }
}

async function runBulkAction(action: DownloadAction) {
  const targets = eligibleFor(action)
  if (bulkPending.value || targets.length === 0)
    return
  const confirmation = action === 'cancel'
    ? `Cancel ${pluralDownloads(targets.length)}? Partial files will be kept so the transfers can be retried.`
    : action === 'delete'
      ? `Delete ${pluralDownloads(targets.length)}? This removes their history and any partial or completed download artifacts.`
      : null
  // eslint-disable-next-line no-alert -- destructive actions require confirmation
  if (confirmation && !window.confirm(confirmation))
    return

  bulkPending.value = action
  const results = await Promise.allSettled(targets.map(d => sendAction(d, action)))
  bulkPending.value = undefined

  const failures = results.filter(r => r.status === 'rejected')
  const done = targets.length - failures.length
  // Keep the failed rows selected so they can be retried or inspected.
  const next = { ...rowSelection.value }
  for (const [index, result] of results.entries()) {
    if (result.status === 'fulfilled')
      delete next[String(targets[index]!.id)]
  }
  rowSelection.value = next

  if (done > 0)
    toast.add({ title: `${BULK_ACTIONS.find(b => b.action === action)!.done} ${pluralDownloads(done)}`, color: 'success' })
  if (failures.length > 0) {
    toast.add({
      title: `Failed to ${action} ${pluralDownloads(failures.length)}`,
      description: extractError(failures[0]!.reason),
      color: 'error',
    })
  }
  await refresh()
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
// Toolbar filters, applied on top of the status chips. Peer and error code
// options come from what's in the loaded list, each with its count.
const search = ref('')
const peerFilter = ref<string[]>([])
const codeFilter = ref<string[]>([])

const peerItems = computed(() => {
  const counts = new Map<string, number>()
  for (const d of data.value?.downloads ?? [])
    counts.set(d.peerName, (counts.get(d.peerName) ?? 0) + 1)
  return Array.from(counts, ([peer, count]) => ({ label: peer, value: peer, count }))
    .sort((a, b) => a.label.localeCompare(b.label))
})

// Grouped like the troubleshooting guide's tables: Download file, Transfer, Import.
const codeItems = computed(() => errorCodeGroups(data.value?.downloads ?? [])
  .map(({ group, codes }) => [
    // Labels aren't selectable; the value only keeps value-key typed.
    { type: 'label' as const, label: group, value: group },
    ...codes.map(({ code, count }) => ({
      label: code,
      value: code,
      count,
      ui: { itemLabel: 'font-mono text-xs' },
    })),
  ]))

// Drop selections whose peer or code no longer appears after a live update.
// Only reassign when something was actually dropped: a new array would count
// as a filter change and send the user back to page one on every update.
function keepPresent(selection: Ref<string[]>, present: Set<string>) {
  const kept = selection.value.filter(value => present.has(value))
  if (kept.length !== selection.value.length)
    selection.value = kept
}
watch(peerItems, (items) => {
  keepPresent(peerFilter, new Set(items.map(item => item.value)))
})
watch(codeItems, (groups) => {
  keepPresent(codeFilter, new Set(groups.flat().filter(item => !('type' in item)).map(item => item.value)))
})

const hasFilters = computed(() => filter.value !== 'all' || search.value.trim() !== '' || peerFilter.value.length > 0 || codeFilter.value.length > 0)
// Only a status chip active: name the status. Anything else: point at the filters.
const emptyMessage = computed(() => {
  const onlyStatus = search.value.trim() === '' && peerFilter.value.length === 0 && codeFilter.value.length === 0
  if (onlyStatus && filter.value !== 'all')
    return `No ${statusBadge[filter.value].label.toLowerCase()} downloads.`
  return 'No downloads match these filters.'
})

function clearFilters() {
  filter.value = 'all'
  search.value = ''
  peerFilter.value = []
  codeFilter.value = []
}

const filtered = computed(() => {
  return (data.value?.downloads ?? []).filter(d =>
    (filter.value === 'all' || d.status === filter.value)
    && matchesSearch(d.filename, search.value)
    && (peerFilter.value.length === 0 || peerFilter.value.includes(d.peerName))
    && (codeFilter.value.length === 0 || (d.errorCode != null && codeFilter.value.includes(d.errorCode))))
})

// Client-side pagination: just slice the filtered list. No server round-trips.
const PAGE_SIZE = 10
const page = ref(1)
const total = computed(() => filtered.value.length)
const pageCount = computed(() => Math.max(1, Math.ceil(total.value / PAGE_SIZE)))
const paged = computed(() => filtered.value.slice((page.value - 1) * PAGE_SIZE, page.value * PAGE_SIZE))
const showingFrom = computed(() => (total.value === 0
  ? 0
  : (page.value - 1) * PAGE_SIZE + 1))
const showingTo = computed(() => Math.min(page.value * PAGE_SIZE, total.value))

// Switching filters starts over at page one; a refresh that shrinks the list
// clamps the current page so we never strand the user on an empty page.
// It also drops the selection, so a bulk action never hits rows the filters hide.
watch([filter, search, peerFilter, codeFilter], () => {
  page.value = 1
  rowSelection.value = {}
})
watch(pageCount, (count) => {
  if (page.value > count)
    page.value = count
})

// Every row expands into its details (failure first, when there is one), so
// the table itself stays one line per download. Keyed by download id (see
// get-row-id), so the right row stays open when live updates reorder the list.
// TanStack's ExpandedState: `true` expands every row.
const expanded = ref<true | Record<string, boolean> | undefined>({})

// The whole row toggles its details. Clicks on the row's own buttons and links
// (the chevron, actions) are left to them.
function onRowSelect(event: Event, row: { toggleExpanded: () => void }) {
  if (event.target instanceof Element && event.target.closest('button, a'))
    return
  row.toggleExpanded()
}

const columns: TableColumn<DownloadItem>[] = [
  { id: 'select', header: '' },
  { id: 'expand', header: '' },
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
          <UBadge :color="connected ? 'success' : 'warning'" variant="subtle" icon="i-ph-broadcast">
            {{ connected ? 'Live' : 'Reconnecting…' }}
          </UBadge>
        </template>
      </UDashboardNavbar>

      <!-- Status chips on the left (they double as the breakdown), the finer
           filters on the right. Wraps instead of scrolling on narrow screens. -->
      <UDashboardToolbar
        v-if="data?.downloads.length"
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
            aria-label="Search downloads by file name"
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

          <USelectMenu
            v-if="codeItems.length"
            v-model="codeFilter"
            :items="codeItems"
            value-key="value"
            multiple
            icon="i-ph-warning-circle"
            size="sm"
            :search-input="{ placeholder: 'Find an error code' }"
            :content="{ align: 'end' }"
            :ui="{ content: 'min-w-64' }"
            class="w-[calc(50%-0.1875rem)] sm:w-40"
            aria-label="Filter by error code"
          >
            <template #default>
              <span class="flex items-center gap-1.5">
                <span :class="codeFilter.length ? 'text-default' : 'text-dimmed'">Error code</span>
                <UBadge v-if="codeFilter.length" :label="String(codeFilter.length)" color="primary" variant="soft" size="sm" />
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
        <!-- Bulk actions for the selected rows; each button counts the rows it applies to. -->
        <div v-if="selected.length" class="flex flex-wrap items-center gap-2">
          <span class="text-sm tabular-nums text-muted">{{ selected.length }} selected</span>
          <UButton
            v-for="bulk in BULK_ACTIONS"
            :key="bulk.action"
            :label="`${bulk.label} (${eligibleFor(bulk.action).length})`"
            :icon="bulk.icon"
            :color="bulk.color"
            :loading="bulkPending === bulk.action"
            :disabled="bulkPending !== undefined || eligibleFor(bulk.action).length === 0"
            variant="subtle"
            size="sm"
            @click="runBulkAction(bulk.action)"
          />
          <UButton
            label="Clear selection"
            icon="i-ph-x"
            color="neutral"
            variant="ghost"
            size="sm"
            :disabled="bulkPending !== undefined"
            @click="rowSelection = {}"
          />
        </div>

        <!-- Desktop: the full table. -->
        <UCard class="hidden lg:block" variant="subtle" :ui="{ body: '!p-0' }">
          <UTable
            v-model:expanded="expanded"
            v-model:row-selection="rowSelection"
            :data="paged"
            :columns="columns"
            :get-row-id="(download: DownloadItem) => String(download.id)"
            :on-select="onRowSelect"
            :meta="{ class: { tr: 'cursor-pointer' } }"
            :ui="{ td: 'align-top' }"
          >
            <template #select-header="{ table }">
              <UCheckbox
                :model-value="table.getIsSomePageRowsSelected() ? 'indeterminate' : table.getIsAllPageRowsSelected()"
                aria-label="Select all downloads on this page"
                @update:model-value="(value: boolean | 'indeterminate') => table.toggleAllPageRowsSelected(value === true)"
              />
            </template>

            <template #select-cell="{ row }">
              <UCheckbox
                :model-value="row.getIsSelected()"
                :aria-label="`Select ${row.original.filename}`"
                @update:model-value="(value: boolean | 'indeterminate') => row.toggleSelected(value === true)"
              />
            </template>

            <template #expand-cell="{ row }">
              <UButton
                icon="i-ph-caret-right"
                color="neutral"
                variant="ghost"
                size="xs"
                :ui="{ leadingIcon: row.getIsExpanded() ? 'transition-transform rotate-90' : 'transition-transform' }"
                :aria-label="row.getIsExpanded() ? 'Hide details' : 'Show details'"
                :aria-expanded="row.getIsExpanded()"
                @click="row.toggleExpanded()"
              />
            </template>

            <template #filename-cell="{ row }">
              <p class="font-medium text-default" :title="row.original.filename">
                {{ row.original.filename }}
              </p>
              <p v-if="row.original.status !== 'failed' && row.original.expectedBytesMismatch" class="text-xs text-warning">
                size mismatch
              </p>
            </template>

            <template #expanded="{ row }">
              <DownloadDetails :download="row.original" class="py-2 pr-2 pl-10" />
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
              <div class="flex flex-col items-center gap-2 py-6 text-sm text-muted">
                <p>{{ emptyMessage }}</p>
                <UButton label="Clear filters" color="neutral" variant="subtle" size="sm" @click="clearFilters" />
              </div>
            </template>
          </UTable>
        </UCard>

        <!-- Mobile: a card per download — a 6-column table is unusable on a phone. -->
        <div class="space-y-2 lg:hidden">
          <UCard v-for="d in paged" :key="d.id" variant="subtle" :ui="{ body: 'p-3' }">
            <div class="space-y-2.5">
              <div class="flex items-start justify-between gap-3">
                <UCheckbox
                  :model-value="rowSelection[String(d.id)] === true"
                  :aria-label="`Select ${d.filename}`"
                  class="mt-0.5"
                  @update:model-value="toggleSelected(d, $event)"
                />
                <div class="min-w-0 flex-1">
                  <p class="font-medium break-words text-default" :title="d.filename">
                    {{ d.filename }}
                  </p>
                  <p v-if="d.status !== 'failed' && d.expectedBytesMismatch" class="mt-0.5 text-xs text-warning">
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
              <UCollapsible>
                <UButton
                  label="Details"
                  color="neutral"
                  variant="link"
                  size="xs"
                  class="px-0"
                  trailing-icon="i-ph-caret-down"
                  :ui="{ trailingIcon: 'transition-transform group-data-[state=open]:rotate-180' }"
                />
                <template #content>
                  <DownloadDetails :download="d" class="pt-2" />
                </template>
              </UCollapsible>
              <DownloadActions
                :download="d"
                :pending="pendingActions[d.id]"
                @action="runAction(d, $event)"
              />
            </div>
          </UCard>

          <div v-if="paged.length === 0" class="flex flex-col items-center gap-2 py-6 text-sm text-muted">
            <p>{{ emptyMessage }}</p>
            <UButton label="Clear filters" color="neutral" variant="subtle" size="sm" @click="clearFilters" />
          </div>
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
