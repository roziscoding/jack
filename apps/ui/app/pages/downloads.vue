<script setup lang="ts">
import type { DownloadItem } from '~/types/management'

const { request } = useManagement()

const { data, pending, error, refresh } = await useAsyncData('downloads', () =>
  request<{ downloads: DownloadItem[] }>('downloads'))

// Auto-refresh controls: an interval picker, a live countdown to the next
// refresh, and a pause/resume toggle. A single 1s ticker drives the countdown
// and fires the refresh when it reaches zero.
const REFRESH_OPTIONS = [
  { label: '2s', ms: 2000 },
  { label: '5s', ms: 5000 },
  { label: '10s', ms: 10_000 },
  { label: '30s', ms: 30_000 },
  { label: '1m', ms: 60_000 },
]
const intervalMs = ref(5000)
const paused = ref(false)
const secondsLeft = ref(Math.ceil(intervalMs.value / 1000))

function resetCountdown() {
  secondsLeft.value = Math.ceil(intervalMs.value / 1000)
}

async function refreshNow() {
  resetCountdown()
  await refresh()
}

function togglePaused() {
  paused.value = !paused.value
  // Resuming refreshes immediately so you're never staring at stale data.
  if (!paused.value)
    void refreshNow()
}

// Restart the countdown whenever the interval changes.
watch(intervalMs, resetCountdown)

let ticker: ReturnType<typeof setInterval> | undefined
onMounted(() => {
  ticker = setInterval(() => {
    if (paused.value)
      return
    secondsLeft.value -= 1
    if (secondsLeft.value <= 0) {
      resetCountdown()
      void refresh()
    }
  }, 1000)
})
onUnmounted(() => clearInterval(ticker))

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
</script>

<template>
  <div>
    <PageHeader title="Downloads" subtitle="Transfers tracked by this jack instance.">
      <template #actions>
        <div class="flex items-center gap-3 text-sm">
          <span class="tabular-nums text-xs text-slate-500">
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

    <div v-else-if="pending" class="text-sm text-slate-500">
      Loading…
    </div>

    <div v-else-if="data && data.downloads.length === 0" class="rounded-xl border border-slate-800 bg-slate-900/40 p-8 text-center text-sm text-slate-500">
      No downloads yet.
    </div>

    <div v-else-if="data" class="overflow-hidden rounded-xl border border-slate-800">
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
          <tr v-for="d in data.downloads" :key="d.id" class="bg-slate-900/20">
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
            <td class="px-4 py-3 text-xs text-slate-500">
              {{ formatDate(d.updatedAt) }}
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>
