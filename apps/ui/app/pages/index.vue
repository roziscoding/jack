<script setup lang="ts">
import type { Overview } from '~/types/management'

const { request } = useManagement()

const { data: overview, pending, error } = await useAsyncData('overview', () =>
  request<Overview>('overview'))

const { connected } = useManagementStream<Overview>('overview/stream', (snapshot) => {
  overview.value = snapshot
})

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
        <!-- What needs doing, first. -->
        <DashboardAttention :overview="overview" />

        <!-- Lifetime totals — the satisfying numbers. -->
        <section>
          <h2 class="mb-3 text-xs font-semibold uppercase tracking-wider text-muted">
            Lifetime
          </h2>
          <div class="grid grid-cols-2 gap-4 lg:grid-cols-4">
            <StatCard label="Imported" :value="overview.downloads.byStatus.imported ?? 0" hint="media files" icon="i-ph-tray-arrow-down" />
            <StatCard label="Data moved" :value="formatBytes(overview.downloads.bytesMoved)" hint="across all peers" icon="i-ph-swap" />
            <StatCard label="Transfers" :value="overview.downloads.total" hint="started" icon="i-ph-download-simple" />
            <StatCard
              label="Peers connected"
              :value="overview.peers.initialized"
              :hint="overview.peers.initialized === 1 ? 'friend sharing' : 'friends sharing'"
              icon="i-ph-users-three"
            />
          </div>
        </section>

        <!-- Live transfer activity. -->
        <section>
          <div class="mb-3 flex items-center justify-between">
            <h2 class="text-xs font-semibold uppercase tracking-wider text-muted">
              Transfers
            </h2>
            <UButton to="/downloads" label="View all downloads" trailing-icon="i-ph-arrow-right" variant="link" size="sm" class="px-0" />
          </div>

          <UCard variant="subtle" :ui="{ body: '!p-0' }">
            <div class="flex flex-wrap items-baseline gap-x-6 gap-y-2 border-b border-default px-5 py-4">
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

            <p v-if="overview.downloads.active.length === 0" class="px-5 py-6 text-sm text-muted">
              No active transfers.
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
              </div>
            </div>
          </UCard>
        </section>

        <!-- Standing inventory: what this node is connected to. -->
        <section>
          <h2 class="mb-3 text-xs font-semibold uppercase tracking-wider text-muted">
            Connections
          </h2>
          <div class="grid gap-4 md:grid-cols-2">
            <!-- Peers -->
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

            <!-- Servers -->
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
        </section>
      </div>
    </template>
  </UDashboardPanel>
</template>
