<script setup lang="ts">
import type { LineSeries } from '~/components/LineChart.vue'
import type { DashboardStats, Overview } from '~/types/management'

const { request, extractError } = useManagement()

const { data: overview, pending, error } = await useAsyncData('overview', () =>
  request<Overview>('overview'))

const { connected } = useManagementStream<Overview>('overview/stream', (snapshot) => {
  overview.value = snapshot
})

// Chart data changes slowly (daily buckets), so it's fetched, not streamed.
const { data: stats, error: statsError, pending: statsPending, refresh: refreshStats } = await useAsyncData('stats', () =>
  request<DashboardStats>('stats'))
const statsTimer = ref<ReturnType<typeof setInterval>>()
onMounted(() => {
  statsTimer.value = setInterval(refreshStats, 60_000)
})
onBeforeUnmount(() => clearInterval(statsTimer.value))

// Peer colors from the shared settings store (single source, consistent across views).
const { settings } = useSettings()
const peerTextClass = (id: string) => settings.value?.peerColors.get(id)?.text ?? peerColorTextClass(id)

// Server connection role, shown in the connections grid (e.g. "source · destination").
function serverRole(server: { source: boolean, destination: boolean }) {
  const roles = []
  if (server.source)
    roles.push('source')
  if (server.destination)
    roles.push('destination')
  return roles.join(' · ') || 'idle'
}

const formatRate = (bps: number) => `${formatBytes(bps)}/s`
const formatSeconds = (seconds: number) => formatDurationMs(seconds * 1000)
const formatCount = (n: number) => n.toLocaleString()

const ratio = computed(() => {
  const down = overview.value?.downloads.bytesMoved ?? 0
  const up = overview.value?.uploads.bytesSent ?? 0
  return down > 0
    ? (up / down).toFixed(2)
    : '—'
})

// Downloads are series slot 1 and uploads slot 2 on every chart.
const volumeSeries = computed(() => [
  { name: 'Downloaded', color: 'var(--viz-1)', values: stats.value?.transfers.map(t => t.downloadedBytes) ?? [] },
  { name: 'Uploaded', color: 'var(--viz-2)', values: stats.value?.transfers.map(t => t.uploadedBytes) ?? [] },
])
const speedSeries = computed<LineSeries[]>(() => [
  { name: 'Download', color: 'var(--viz-1)', values: stats.value?.transfers.map(t => t.downloadBps) ?? [] },
  { name: 'Upload', color: 'var(--viz-2)', values: stats.value?.transfers.map(t => t.uploadBps) ?? [] },
])
const hasActivity = computed(() => volumeSeries.value.some(s => s.values.some(v => v > 0)))

const latencySeries = computed<LineSeries[]>(() => [
  { name: 'Import time', color: 'var(--viz-1)', values: stats.value?.importLatency.map(l => l.avgSeconds) ?? [] },
])
const hasLatency = computed(() => stats.value?.importLatency.some(l => l.count > 0) ?? false)

// One line per catalog. Colors follow the source (this instance first, then peers
// by id), so a peer keeps its color as others come and go. Eight slots, so at
// most eight lines.
const CATALOG_SLOTS = 8
const catalogSeries = computed<LineSeries[]>(() => {
  const s = stats.value
  if (!s)
    return []
  const sources = [...s.catalog.sources].sort((a, b) =>
    a.id === 'self'
      ? -1
      : b.id === 'self'
        ? 1
        : a.id.localeCompare(b.id))
  return sources.slice(0, CATALOG_SLOTS).map((source, i) => {
    const byDay = new Map(s.catalog.points.filter(p => p.sourceId === source.id).map(p => [p.day, p.titles]))
    return {
      name: source.name,
      color: `var(--viz-${i + 1})`,
      values: s.days.map(day => byDay.get(day) ?? null),
    }
  })
})
</script>

<template>
  <UDashboardPanel id="dashboard">
    <template #header>
      <UDashboardNavbar title="Dashboard">
        <template #right>
          <UBadge :color="connected ? 'success' : 'warning'" variant="subtle" icon="i-ph-broadcast">
            {{ connected ? 'Live' : 'Reconnecting…' }}
          </UBadge>
        </template>
      </UDashboardNavbar>
    </template>

    <template #body>
      <UAlert v-if="error" color="error" variant="soft" icon="i-ph-warning" title="Failed to load overview." />

      <p v-else-if="pending && !overview" class="flex items-center gap-2 text-sm text-muted">
        <UIcon name="i-ph-circle-notch" class="size-4 animate-spin" />
        Loading…
      </p>

      <div v-else-if="overview" class="space-y-8">
        <!-- Lifetime totals: the satisfying numbers. -->
        <DashSection title="Lifetime">
          <div class="grid grid-cols-2 gap-4 lg:grid-cols-5">
            <StatCard label="Imported" :value="overview.downloads.byStatus.imported ?? 0" hint="media files" icon="i-ph-tray-arrow-down" />
            <StatCard label="Downloaded" :value="formatBytes(overview.downloads.bytesMoved)" hint="from peers" icon="i-ph-download-simple" />
            <StatCard label="Uploaded" :value="formatBytes(overview.uploads.bytesSent)" hint="to peers" icon="i-ph-upload-simple" />
            <StatCard label="Ratio" :value="ratio" hint="uploaded / downloaded" icon="i-ph-scales" />
            <StatCard label="Transfers" :value="overview.downloads.total + overview.uploads.total" hint="downloads and uploads" icon="i-ph-swap" />
          </div>
        </DashSection>

        <!-- What needs doing; renders nothing when all is well. -->
        <DashboardAttention :overview="overview" />

        <!-- Standing inventory: what this node is connected to. -->
        <DashSection title="Connections">
          <div class="grid gap-4 md:grid-cols-2">
            <UCard variant="subtle" :ui="{ body: '!p-0' }">
              <div class="flex items-center justify-between border-b border-default px-4 py-3">
                <span class="text-xs font-semibold uppercase tracking-wide text-muted">Peers</span>
                <span class="text-xs tabular-nums text-dimmed">
                  {{ overview.peers.initialized }} / {{ overview.peers.total }} online
                </span>
              </div>
              <p v-if="overview.peers.total === 0" class="px-4 py-5 text-sm text-muted">
                No peers yet.
              </p>
              <div v-else class="divide-y divide-default">
                <div v-for="peer in overview.peers.items" :key="peer.id" class="flex items-center gap-3 px-4 py-2.5">
                  <ConnDot :initialized="peer.initialized" :error="peer.initializationError" :accent-class="peerTextClass(peer.id)" />
                  <span class="flex-1 truncate text-sm text-default" :title="peer.name">{{ peer.name }}</span>
                  <span class="text-xs tabular-nums" :class="peer.initialized ? 'text-muted' : 'text-error'">
                    {{ peer.initialized ? (peer.version ?? '—') : 'unreachable' }}
                  </span>
                </div>
              </div>
            </UCard>

            <UCard variant="subtle" :ui="{ body: '!p-0' }">
              <div class="flex items-center justify-between border-b border-default px-4 py-3">
                <span class="text-xs font-semibold uppercase tracking-wide text-muted">Servers</span>
                <span class="text-xs tabular-nums text-dimmed">
                  {{ overview.servers.initialized }} / {{ overview.servers.total }} online
                </span>
              </div>
              <p v-if="overview.servers.total === 0" class="px-4 py-5 text-sm text-muted">
                No servers yet.
              </p>
              <div v-else class="divide-y divide-default">
                <div v-for="server in overview.servers.items" :key="server.id" class="flex items-center gap-3 px-4 py-2.5">
                  <ConnDot :initialized="server.initialized" :error="server.initializationError" />
                  <span class="flex-1 truncate text-sm text-default" :title="server.name">{{ server.name }}</span>
                  <span class="text-xs" :class="server.initialized ? 'text-muted' : 'text-error'">
                    {{ server.initialized ? serverRole(server) : 'unreachable' }}
                  </span>
                </div>
              </div>
            </UCard>
          </div>
        </DashSection>

        <!-- The charts load separately from the live overview; say so when they don't. -->
        <UAlert
          v-if="statsError && !stats"
          color="error"
          variant="soft"
          icon="i-ph-warning"
          title="Failed to load the charts."
          :description="extractError(statsError)"
          :actions="[{ label: 'Retry', color: 'error', variant: 'subtle', loading: statsPending, onClick: () => refreshStats() }]"
        />

        <template v-if="stats">
          <!-- Daily volume and speed over the last 30 days. -->
          <DashSection title="Activity">
            <div class="grid gap-4 xl:grid-cols-2">
              <UCard variant="subtle">
                <p class="text-sm font-medium text-highlighted">
                  Data moved per day
                </p>
                <p class="mb-4 text-xs text-muted">
                  Bytes of finished transfers, last 30 days
                </p>
                <ColumnChart v-if="hasActivity" :days="stats.days" :series="volumeSeries" :format="formatBytes" />
                <p v-else class="py-4 text-sm text-muted">
                  Nothing moved in the last 30 days.
                </p>
              </UCard>
              <UCard variant="subtle">
                <p class="text-sm font-medium text-highlighted">
                  Average speed
                </p>
                <p class="mb-4 text-xs text-muted">
                  Bytes over transfer time for each day's finished transfers, including retry waits
                </p>
                <LineChart v-if="hasActivity" :days="stats.days" :series="speedSeries" :format="formatRate" />
                <p v-else class="py-4 text-sm text-muted">
                  No finished transfers in the last 30 days.
                </p>
              </UCard>
            </div>
          </DashSection>

          <!-- Who the data went to and came from, lifetime. -->
          <DashSection title="Peer split">
            <div class="grid gap-4 md:grid-cols-2">
              <UCard variant="subtle">
                <p class="mb-4 text-sm font-medium text-highlighted">
                  Pulled the most from you
                </p>
                <RankBars
                  :items="stats.peers.tookFromMe.map(p => ({ key: p.id, label: p.name, value: p.bytes }))"
                  :format="formatBytes"
                  color="var(--viz-2)"
                  empty="No peer has pulled from you yet."
                />
              </UCard>
              <UCard variant="subtle">
                <p class="mb-4 text-sm font-medium text-highlighted">
                  You pulled the most from
                </p>
                <RankBars
                  :items="stats.peers.gaveToMe.map(p => ({ key: p.id, label: p.name, value: p.bytes }))"
                  :format="formatBytes"
                  color="var(--viz-1)"
                  empty="You haven't downloaded from a peer yet."
                />
              </UCard>
            </div>
          </DashSection>

          <!-- What's on offer, and what's popular. -->
          <DashSection title="Library">
            <div class="grid gap-4 xl:grid-cols-2">
              <UCard variant="subtle">
                <p class="text-sm font-medium text-highlighted">
                  Catalog size
                </p>
                <p class="mb-4 text-xs text-muted">
                  Titles in your catalog and each peer's, recorded at every catalog sync
                </p>
                <LineChart v-if="catalogSeries.length" :days="stats.days" :series="catalogSeries" :format="formatCount" />
                <p v-else class="py-4 text-sm text-muted">
                  No catalog sync recorded yet.
                </p>
              </UCard>
              <UCard variant="subtle">
                <p class="mb-4 text-sm font-medium text-highlighted">
                  Most pulled from you
                </p>
                <RankBars
                  :items="stats.topTitles.map(t => ({ label: t.filename, value: t.bytes, hint: `${t.peers} ${t.peers === 1 ? 'peer' : 'peers'}` }))"
                  :format="formatBytes"
                  color="var(--viz-2)"
                  empty="Nothing pulled from you yet."
                />
              </UCard>
            </div>
          </DashSection>

          <!-- How smoothly downloads reach the library. -->
          <DashSection title="Imports and failures">
            <div class="grid gap-4 xl:grid-cols-2">
              <UCard variant="subtle">
                <p class="text-sm font-medium text-highlighted">
                  Import time
                </p>
                <p class="mb-4 text-xs text-muted">
                  Average time from download finished to *arr import, by import day
                </p>
                <LineChart v-if="hasLatency" :days="stats.days" :series="latencySeries" :format="formatSeconds" />
                <p v-else class="py-4 text-sm text-muted">
                  No imports recorded in the last 30 days.
                </p>
              </UCard>
              <UCard variant="subtle">
                <div class="mb-4 flex items-center justify-between gap-2">
                  <p class="text-sm font-medium text-highlighted">
                    Failed downloads by error code
                  </p>
                  <UButton to="/downloads" label="Review" trailing-icon="i-ph-arrow-right" variant="link" size="sm" class="px-0" />
                </div>
                <RankBars
                  :items="stats.failures.map(f => ({ label: f.code, value: f.count }))"
                  :format="formatCount"
                  color="var(--viz-8)"
                  empty="No failed downloads."
                />
              </UCard>
            </div>
          </DashSection>
        </template>

        <!-- Live transfer activity, both ways. -->
        <DashSection title="Transfers">
          <div class="space-y-4">
            <UCard variant="subtle" :ui="{ body: '!p-0' }">
              <div class="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 border-b border-default px-5 py-4">
                <div class="flex flex-wrap items-baseline gap-x-6 gap-y-2">
                  <span class="flex items-baseline gap-2">
                    <span class="text-xl font-semibold tabular-nums text-primary">{{ overview.downloads.byStatus.downloading ?? 0 }}</span>
                    <span class="text-sm text-muted">Downloading</span>
                  </span>
                  <span class="flex items-baseline gap-2">
                    <span class="text-xl font-semibold tabular-nums text-warning">{{ overview.downloads.byStatus.import_queued ?? 0 }}</span>
                    <span class="text-sm text-muted">Queued for import</span>
                  </span>
                  <span class="flex items-baseline gap-2">
                    <span class="text-xl font-semibold tabular-nums text-error">{{ overview.downloads.byStatus.failed ?? 0 }}</span>
                    <span class="text-sm text-muted">Failed</span>
                  </span>
                </div>
                <UButton to="/downloads" label="View all downloads" trailing-icon="i-ph-arrow-right" variant="link" size="sm" class="px-0" />
              </div>

              <p v-if="overview.downloads.active.length === 0" class="px-5 py-6 text-sm text-muted">
                No active downloads.
              </p>
              <div v-else class="divide-y divide-default">
                <div v-for="d in overview.downloads.active" :key="d.id" class="px-5 py-4">
                  <div class="flex items-center justify-between gap-4">
                    <p class="truncate text-sm font-medium text-default" :title="d.filename">
                      {{ d.filename }}
                    </p>
                    <p class="shrink-0 text-xs text-muted">
                      from <span class="text-toned">{{ d.peerName }}</span>
                    </p>
                  </div>
                  <div class="mt-2.5 flex items-center gap-3">
                    <ProgressBar :value="d.progress" />
                    <span class="w-28 shrink-0 text-right text-xs tabular-nums text-muted">
                      {{ formatBytes(d.downloadedBytes) }} / {{ formatBytes(d.totalBytes) }}
                    </span>
                  </div>
                  <p v-if="d.speedBps != null" class="mt-1 text-xs tabular-nums text-muted">
                    {{ formatTransferRate(d.speedBps, d.etaSeconds) }}
                  </p>
                </div>
              </div>
            </UCard>

            <UCard variant="subtle" :ui="{ body: '!p-0' }">
              <div class="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 border-b border-default px-5 py-4">
                <div class="flex flex-wrap items-baseline gap-x-6 gap-y-2">
                  <span class="flex items-baseline gap-2">
                    <span class="text-xl font-semibold tabular-nums text-primary">{{ overview.uploads.byStatus.uploading ?? 0 }}</span>
                    <span class="text-sm text-muted">Uploading</span>
                  </span>
                  <span class="flex items-baseline gap-2">
                    <span class="text-xl font-semibold tabular-nums text-success">{{ overview.uploads.byStatus.completed ?? 0 }}</span>
                    <span class="text-sm text-muted">Completed</span>
                  </span>
                </div>
                <UButton to="/uploads" label="View all uploads" trailing-icon="i-ph-arrow-right" variant="link" size="sm" class="px-0" />
              </div>

              <p v-if="overview.uploads.active.length === 0" class="px-5 py-6 text-sm text-muted">
                No peer is pulling from you right now.
              </p>
              <div v-else class="divide-y divide-default">
                <div v-for="u in overview.uploads.active" :key="u.id" class="px-5 py-4">
                  <div class="flex items-center justify-between gap-4">
                    <p class="truncate text-sm font-medium text-default" :title="u.filename">
                      {{ u.filename }}
                    </p>
                    <p class="shrink-0 text-xs text-muted">
                      to <span class="text-toned">{{ u.peerName }}</span>
                    </p>
                  </div>
                  <!-- Sent zero-copy: no live progress, only how much this request covers. -->
                  <p class="mt-1 text-xs tabular-nums text-muted">
                    Sending {{ formatBytes(u.requestedBytes) }} of {{ formatBytes(u.totalBytes) }} · started {{ formatAgo(u.startedAt) }} ago
                  </p>
                </div>
              </div>
            </UCard>
          </div>
        </DashSection>
      </div>
    </template>
  </UDashboardPanel>
</template>
