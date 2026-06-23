<script setup lang="ts">
import type { DownloadItem } from '~/types/management'

const { request } = useManagement()

const { data, pending, error, refresh } = await useAsyncData('downloads', () =>
  request<{ downloads: DownloadItem[] }>('downloads'))

let timer: ReturnType<typeof setInterval> | undefined
onMounted(() => {
  timer = setInterval(refresh, 5000)
})
onUnmounted(() => clearInterval(timer))

const statusTone: Record<DownloadItem['status'], string> = {
  downloading: 'bg-brand-500/20 text-brand-400',
  completed: 'bg-emerald-950/60 text-emerald-300',
  failed: 'bg-rose-950/60 text-rose-300',
  import_queued: 'bg-amber-950/60 text-amber-300',
}
const statusLabel: Record<DownloadItem['status'], string> = {
  downloading: 'Downloading',
  completed: 'Completed',
  failed: 'Failed',
  import_queued: 'Import queued',
}
</script>

<template>
  <div>
    <PageHeader title="Downloads" subtitle="Transfers tracked by this jack instance." />

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
