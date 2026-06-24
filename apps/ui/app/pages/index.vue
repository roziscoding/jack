<script setup lang="ts">
import type { Overview } from '~/types/management'

const { request } = useManagement()

const { data: overview, pending, error, refresh } = await useAsyncData('overview', () =>
  request<Overview>('overview'))

const { REFRESH_OPTIONS, intervalMs, paused, secondsLeft, togglePaused } = useAutoRefresh(refresh)

// Server connection role, shown in the connections grid (e.g. "source · destination").
function serverRole(server: { source: boolean, destination: boolean }) {
  const roles = []
  if (server.source)
    roles.push('source')
  if (server.destination)
    roles.push('destination')
  return roles.join(' · ') || 'idle'
}
</script>

<template>
  <div>
    <PageHeader title="Dashboard" subtitle="Health and live activity for this node.">
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
      Failed to load overview.
    </div>

    <div v-else-if="pending && !overview" class="text-sm text-slate-500">
      Loading…
    </div>

    <template v-else-if="overview">
      <!-- What needs doing, first. -->
      <DashboardAttention :overview="overview" />

      <!-- Lifetime totals — the satisfying numbers. -->
      <h2 class="mb-3 mt-8 text-xs font-semibold uppercase tracking-wider text-slate-400">
        Lifetime
      </h2>
      <div class="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard label="Imported" :value="overview.downloads.byStatus.imported ?? 0" hint="media files" />
        <StatCard label="Data moved" :value="formatBytes(overview.downloads.bytesMoved)" hint="across all peers" />
        <StatCard label="Transfers" :value="overview.downloads.total" hint="started" />
        <StatCard
          label="Peers connected"
          :value="overview.peers.initialized"
          :hint="overview.peers.initialized === 1 ? 'friend sharing' : 'friends sharing'"
        />
      </div>

      <!-- Live transfer activity. -->
      <div class="mb-3 mt-8 flex items-center justify-between">
        <h2 class="text-xs font-semibold uppercase tracking-wider text-slate-400">
          Transfers
        </h2>
        <NuxtLink to="/downloads" class="text-sm text-brand-400 hover:text-brand-300">
          View all downloads →
        </NuxtLink>
      </div>
      <div class="overflow-hidden rounded-xl border border-slate-800 bg-slate-900/40">
        <div class="flex flex-wrap items-baseline gap-x-6 gap-y-2 border-b border-slate-800 px-5 py-4">
          <span class="flex items-baseline gap-2">
            <span class="text-xl font-semibold tabular-nums text-brand-400">{{ overview.downloads.byStatus.downloading ?? 0 }}</span>
            <span class="text-sm text-slate-400">Downloading</span>
          </span>
          <span class="flex items-baseline gap-2">
            <span class="text-xl font-semibold tabular-nums text-amber-300">{{ overview.downloads.byStatus.import_queued ?? 0 }}</span>
            <span class="text-sm text-slate-400">Queued for import</span>
          </span>
          <span class="flex items-baseline gap-2">
            <span class="text-xl font-semibold tabular-nums text-rose-300">{{ overview.downloads.byStatus.failed ?? 0 }}</span>
            <span class="text-sm text-slate-400">Failed</span>
          </span>
        </div>

        <div v-if="overview.downloads.active.length === 0" class="px-5 py-6 text-sm text-slate-500">
          No active transfers.
        </div>
        <div v-else class="divide-y divide-slate-800">
          <div v-for="d in overview.downloads.active" :key="d.id" class="px-5 py-4">
            <div class="flex items-center justify-between gap-4">
              <p class="truncate text-sm font-medium" :title="d.filename">
                {{ d.filename }}
              </p>
              <p class="shrink-0 text-xs text-slate-500">
                from <span class="text-slate-400">{{ d.peerName }}</span>
              </p>
            </div>
            <div class="mt-2.5 flex items-center gap-3">
              <ProgressBar :value="d.progress" />
              <span class="w-28 shrink-0 text-right text-xs tabular-nums text-slate-500">
                {{ formatBytes(d.downloadedBytes) }} / {{ formatBytes(d.totalBytes) }}
              </span>
            </div>
          </div>
        </div>
      </div>

      <!-- Standing inventory: what this node is connected to. -->
      <h2 class="mb-3 mt-8 text-xs font-semibold uppercase tracking-wider text-slate-400">
        Connections
      </h2>
      <div class="grid gap-4 md:grid-cols-2">
        <!-- Peers -->
        <div class="overflow-hidden rounded-xl border border-slate-800 bg-slate-900/40">
          <div class="flex items-center justify-between border-b border-slate-800 px-4 py-3">
            <span class="text-xs font-semibold uppercase tracking-wide text-slate-500">Peers</span>
            <span class="text-xs tabular-nums text-slate-600">
              {{ overview.peers.initialized }} / {{ overview.peers.total }} online
            </span>
          </div>
          <p v-if="overview.peers.total === 0" class="px-4 py-5 text-sm text-slate-500">
            No peers yet.
          </p>
          <div v-else class="divide-y divide-slate-800/60">
            <div v-for="peer in overview.peers.items" :key="peer.id" class="flex items-center gap-3 px-4 py-2.5">
              <ConnDot :initialized="peer.initialized" :error="peer.initializationError" />
              <span class="flex-1 truncate text-sm" :title="peer.name">{{ peer.name }}</span>
              <span
                class="text-xs tabular-nums"
                :class="peer.initialized ? 'text-slate-500' : 'text-rose-300'"
              >
                {{ peer.initialized ? (peer.version ?? '—') : 'unreachable' }}
              </span>
            </div>
          </div>
        </div>

        <!-- Servers -->
        <div class="overflow-hidden rounded-xl border border-slate-800 bg-slate-900/40">
          <div class="flex items-center justify-between border-b border-slate-800 px-4 py-3">
            <span class="text-xs font-semibold uppercase tracking-wide text-slate-500">Servers</span>
            <span class="text-xs tabular-nums text-slate-600">
              {{ overview.servers.initialized }} / {{ overview.servers.total }} online
            </span>
          </div>
          <p v-if="overview.servers.total === 0" class="px-4 py-5 text-sm text-slate-500">
            No servers yet.
          </p>
          <div v-else class="divide-y divide-slate-800/60">
            <div v-for="server in overview.servers.items" :key="server.id" class="flex items-center gap-3 px-4 py-2.5">
              <ConnDot :initialized="server.initialized" :error="server.initializationError" />
              <span class="flex-1 truncate text-sm" :title="server.name">{{ server.name }}</span>
              <span
                class="text-xs"
                :class="server.initialized ? 'text-slate-500' : 'text-rose-300'"
              >
                {{ server.initialized ? serverRole(server) : 'unreachable' }}
              </span>
            </div>
          </div>
        </div>
      </div>
    </template>
  </div>
</template>
