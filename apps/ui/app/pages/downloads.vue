<script setup lang="ts">
import type { DownloadItem } from '~/types/management'

type StatusFilter = DownloadItem['status'] | 'all'

const { request } = useManagement()

const { data, pending, error, refresh } = await useAsyncData('downloads', () =>
  request<{ downloads: DownloadItem[] }>('downloads'))

const { REFRESH_OPTIONS, intervalMs, paused, secondsLeft, togglePaused } = useAutoRefresh(refresh)

const statusTone: Record<DownloadItem['status'], string> = {
  downloading: 'bg-brand-500/20 text-brand-400',
  import_queued: 'bg-amber-950/60 text-amber-300',
  imported: 'bg-emerald-950/60 text-emerald-300',
  failed: 'bg-rose-950/60 text-rose-300',
}
const statusLabel: Record<DownloadItem['status'], string> = {
  downloading: 'Downloading',
  import_queued: 'Import queued',
  imported: 'Imported',
  failed: 'Failed',
}
const countTone: Record<StatusFilter, string> = {
  all: 'text-slate-500',
  downloading: 'text-brand-400',
  import_queued: 'text-amber-300',
  imported: 'text-emerald-300',
  failed: 'text-rose-300',
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
const chips = computed<{ key: StatusFilter, label: string }[]>(() => [
  { key: 'all', label: 'All' },
  { key: 'downloading', label: 'Downloading' },
  { key: 'import_queued', label: 'Import queued' },
  { key: 'imported', label: 'Imported' },
  { key: 'failed', label: 'Failed' },
])
const filtered = computed(() => {
  const all = data.value?.downloads ?? []
  return filter.value === 'all' ? all : all.filter(d => d.status === filter.value)
})
</script>

<template>
  <div>
    <PageHeader title="Downloads" subtitle="Transfers tracked by this jack instance.">
      <template #actions>
        <div class="flex items-center gap-3 text-sm">
          <span class="text-xs tabular-nums text-slate-500">
            {{ paused ? 'Auto-refresh paused' : `Next refresh in ${secondsLeft}s` }}
          </span>
          <select
            v-model.number="intervalMs"
            class="rounded-lg border border-slate-700 bg-slate-950 px-2 py-1.5 text-xs outline-none focus:border-brand-500"
            aria-label="Auto-refresh interval"
          >
            <option v-for="opt in REFRESH_OPTIONS" :key="opt.ms" :value="opt.ms">
              Every {{ opt.label }}
            </option>
          </select>
          <button
            class="rounded-lg border border-slate-700 px-3 py-1.5 text-xs font-medium text-slate-300 transition hover:border-slate-500 hover:text-slate-100"
            @click="togglePaused"
          >
            {{ paused ? 'Resume' : 'Pause' }}
          </button>
        </div>
      </template>
    </PageHeader>

    <div v-if="error" class="rounded-xl border border-rose-900/60 bg-rose-950/30 p-4 text-sm text-rose-200">
      Failed to load downloads.
    </div>

    <div v-else-if="pending && !data" class="text-sm text-slate-500">
      Loading…
    </div>

    <div v-else-if="data && data.downloads.length === 0" class="rounded-xl border border-slate-800 bg-slate-900/40 p-8 text-center text-sm text-slate-500">
      No downloads yet. Transfers show up here once a peer release starts pulling.
    </div>

    <div v-else-if="data">
      <!-- Status filter / breakdown -->
      <div class="mb-4 flex flex-wrap gap-2">
        <button
          v-for="chip in chips"
          :key="chip.key"
          class="rounded-lg border px-3 py-1.5 text-xs font-medium transition"
          :class="filter === chip.key
            ? 'border-brand-500 bg-brand-500/10 text-slate-100'
            : 'border-slate-700 text-slate-400 hover:border-slate-500 hover:text-slate-200'"
          @click="filter = chip.key"
        >
          {{ chip.label }}
          <span class="ml-1 tabular-nums" :class="countTone[chip.key]">{{ counts[chip.key] }}</span>
        </button>
      </div>

      <div v-if="filtered.length === 0" class="rounded-xl border border-slate-800 bg-slate-900/40 p-8 text-center text-sm text-slate-500">
        No {{ statusLabel[filter as DownloadItem['status']].toLowerCase() }} downloads.
      </div>

      <div v-else class="overflow-hidden rounded-xl border border-slate-800">
        <table class="w-full text-left text-sm">
          <thead class="bg-slate-900/60 text-xs uppercase tracking-wide text-slate-500">
            <tr>
              <th class="px-4 py-3 font-medium">
                File
              </th>
              <th class="px-4 py-3 font-medium">
                Peer
              </th>
              <th class="px-4 py-3 font-medium">
                Status
              </th>
              <th class="w-48 px-4 py-3 font-medium">
                Progress
              </th>
              <th class="px-4 py-3 font-medium">
                Size
              </th>
              <th class="px-4 py-3 font-medium">
                Updated
              </th>
            </tr>
          </thead>
          <tbody class="divide-y divide-slate-800">
            <tr v-for="d in filtered" :key="d.id" class="bg-slate-900/20">
              <td class="max-w-xs px-4 py-3">
                <p class="truncate font-medium" :title="d.filename">
                  {{ d.filename }}
                </p>
                <p v-if="d.error" class="truncate text-xs text-rose-400" :title="d.error">
                  {{ d.error }}
                </p>
                <p v-else-if="d.expectedBytesMismatch" class="text-xs text-amber-400">
                  size mismatch
                </p>
              </td>
              <td class="px-4 py-3 text-slate-400">
                {{ d.peerName }}
              </td>
              <td class="px-4 py-3">
                <span class="inline-flex rounded-full px-2.5 py-0.5 text-xs font-medium" :class="statusTone[d.status]">
                  {{ statusLabel[d.status] }}
                </span>
              </td>
              <td class="px-4 py-3">
                <ProgressBar :value="d.progress" />
              </td>
              <td class="px-4 py-3 text-slate-400">
                {{ formatBytes(d.totalBytes) }}
              </td>
              <td class="px-4 py-3 text-xs tabular-nums text-slate-500" :title="formatDate(d.updatedAt)">
                {{ formatAgo(d.updatedAt) }} ago
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>
</template>
