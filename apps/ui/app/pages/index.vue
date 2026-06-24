<script setup lang="ts">
import type { Overview } from '~/types/management'

const { request } = useManagement()

const { data: overview, pending, error, refresh } = await useAsyncData('overview', () =>
  request<Overview>('overview'))

// Light polling so active downloads tick without a manual refresh.
let timer: ReturnType<typeof setInterval> | undefined
onMounted(() => {
  timer = setInterval(refresh, 5000)
})
onUnmounted(() => clearInterval(timer))
</script>

<template>
  <div>
    <PageHeader title="Dashboard" subtitle="Live view of peers, servers and transfers." />

    <div v-if="error" class="rounded-xl border border-rose-900/60 bg-rose-950/30 p-4 text-sm text-rose-200">
      Failed to load overview.
    </div>

    <template v-else-if="overview">
      <div class="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard
          label="Peers"
          :value="`${overview.peers.initialized}/${overview.peers.total}`"
          hint="connected / total"
        />
        <StatCard
          label="Servers"
          :value="`${overview.servers.initialized}/${overview.servers.total}`"
          :hint="`${overview.servers.sources} sources · ${overview.servers.destinations} destinations`"
        />
        <StatCard
          label="Active downloads"
          :value="overview.downloads.active.length"
          :hint="`${overview.downloads.total} total`"
        />
        <StatCard
          label="Imported"
          :value="overview.downloads.byStatus.imported ?? 0"
          :hint="`${overview.downloads.byStatus.failed ?? 0} failed`"
        />
      </div>

      <section class="mt-8">
        <h2 class="mb-3 text-sm font-medium text-slate-300">
          Active downloads
        </h2>
        <div v-if="overview.downloads.active.length === 0" class="rounded-xl border border-slate-800 bg-slate-900/40 p-6 text-sm text-slate-500">
          Nothing downloading right now.
        </div>
        <div v-else class="divide-y divide-slate-800 overflow-hidden rounded-xl border border-slate-800 bg-slate-900/40">
          <div v-for="d in overview.downloads.active" :key="d.id" class="p-4">
            <div class="flex items-center justify-between gap-4">
              <div class="min-w-0">
                <p class="truncate text-sm font-medium">
                  {{ d.filename }}
                </p>
                <p class="text-xs text-slate-500">
                  from {{ d.peerName }} · {{ formatBytes(d.downloadedBytes) }} / {{ formatBytes(d.totalBytes) }}
                </p>
              </div>
            </div>
            <div class="mt-2">
              <ProgressBar :value="d.progress" />
            </div>
          </div>
        </div>
      </section>
    </template>

    <div v-else-if="pending" class="text-sm text-slate-500">
      Loading…
    </div>
  </div>
</template>
