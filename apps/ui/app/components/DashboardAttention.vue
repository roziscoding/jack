<script setup lang="ts">
import type { Overview } from '~/types/management'

const props = defineProps<{ overview: Overview }>()

const STORAGE_KEY = 'jack:dashboard:attention-collapsed'
// How many example rows to list before collapsing the rest into "and N more".
const PREVIEW = 3

// Only connectors that actually failed to initialize are "issues" — ones still
// handshaking on startup (no error yet) are transient, not something to act on.
const unreachablePeers = computed(() => props.overview.peers.items.filter(p => !p.initialized && p.initializationError))
const unreachableServers = computed(() => props.overview.servers.items.filter(s => !s.initialized && s.initializationError))
const stuckImports = computed(() => props.overview.downloads.importQueued)
const failed = computed(() => props.overview.downloads.failed)
const failedCount = computed(() => props.overview.downloads.byStatus.failed ?? 0)
const queuedCount = computed(() => props.overview.downloads.byStatus.import_queued ?? 0)
// Live integrity warnings: only for in-flight/queued transfers — failed rows
// already carry their own error message below. The headline count uses the true
// backend total (`mismatched`); the rows are example detail from the capped lists.
const mismatchCount = computed(() => props.overview.downloads.mismatched)
const mismatches = computed(() =>
  [...props.overview.downloads.active, ...props.overview.downloads.importQueued]
    .filter(d => d.expectedBytesMismatch))

// Each unreachable connector is its own fixable thing; download problems collapse
// to one line each. The count drives the badge.
const issueCount = computed(() =>
  unreachablePeers.value.length
  + unreachableServers.value.length
  + (queuedCount.value ? 1 : 0)
  + (failedCount.value ? 1 : 0)
  + (mismatchCount.value ? 1 : 0))
const hasIssues = computed(() => issueCount.value > 0)

const open = ref(true)
onMounted(() => {
  open.value = localStorage.getItem(STORAGE_KEY) !== '1'
})
watch(open, (v) => {
  localStorage.setItem(STORAGE_KEY, v ? '0' : '1')
})

function plural(n: number, word: string) {
  return `${n} ${word}${n === 1 ? '' : 's'}`
}
</script>

<template>
  <!-- All clear: one calm line, nothing to collapse. -->
  <UAlert
    v-if="!hasIssues"
    color="success"
    variant="soft"
    icon="i-ph-check-circle"
    title="Everything's connected and nothing's failing."
  />

  <!-- Something needs doing. -->
  <UCard v-else variant="subtle" :ui="{ body: '!p-0' }">
    <UCollapsible v-model:open="open" :ui="{ root: 'group' }">
      <button type="button" class="flex w-full items-center gap-3 px-4 py-3.5 text-left">
        <UIcon name="i-ph-caret-down" class="size-4 text-muted transition-transform group-data-[state=closed]:-rotate-90" />
        <span class="text-sm font-semibold text-highlighted">Needs attention</span>
        <UBadge class="ml-auto" color="error" variant="subtle" :label="plural(issueCount, 'issue')" />
      </button>

      <template #content>
        <div class="divide-y divide-default border-t border-default">
          <!-- Unreachable peers -->
          <div v-for="peer in unreachablePeers" :key="`peer-${peer.id}`" class="flex gap-3 px-4 py-3">
            <UIcon name="i-ph-warning-circle" class="mt-0.5 size-4 shrink-0 text-error" />
            <p class="min-w-0 text-sm text-default">
              <span class="font-semibold">{{ peer.name }}</span> peer unreachable<template v-if="peer.initializationError">
                — <span class="font-mono text-xs text-error">{{ peer.initializationError }}</span>
              </template>
            </p>
          </div>

          <!-- Unreachable servers -->
          <div v-for="server in unreachableServers" :key="`server-${server.id}`" class="flex gap-3 px-4 py-3">
            <UIcon name="i-ph-warning-circle" class="mt-0.5 size-4 shrink-0 text-error" />
            <p class="min-w-0 text-sm text-default">
              <span class="font-semibold">{{ server.name }}</span> server unreachable<template v-if="server.initializationError">
                — <span class="font-mono text-xs text-error">{{ server.initializationError }}</span>
              </template>
            </p>
          </div>

          <!-- Stuck imports -->
          <div v-if="queuedCount" class="flex gap-3 px-4 py-3">
            <UIcon name="i-ph-clock-countdown" class="mt-0.5 size-4 shrink-0 text-warning" />
            <div class="min-w-0">
              <p class="text-sm text-default">
                {{ plural(queuedCount, 'download') }} waiting for *arr to import
              </p>
              <p
                v-for="d in stuckImports.slice(0, PREVIEW)"
                :key="d.id"
                class="mt-1 truncate text-xs text-muted"
                :title="d.filename"
              >
                <span class="text-toned">{{ d.filename }}</span>
                · from {{ d.peerName }}
                · waiting {{ formatAgo(d.completedAt ?? d.updatedAt) }}
              </p>
              <p v-if="queuedCount > PREVIEW" class="mt-1 text-xs text-dimmed">
                and {{ queuedCount - PREVIEW }} more
              </p>
            </div>
          </div>

          <!-- Failed downloads -->
          <div v-if="failedCount" class="flex items-start gap-3 px-4 py-3">
            <UIcon name="i-ph-x-circle" class="mt-0.5 size-4 shrink-0 text-error" />
            <div class="min-w-0 flex-1">
              <p class="text-sm text-default">
                {{ plural(failedCount, 'download') }} failed
              </p>
              <p
                v-for="d in failed.slice(0, PREVIEW)"
                :key="d.id"
                class="mt-1 truncate text-xs text-muted"
                :title="d.error ?? undefined"
              >
                <span class="text-toned">{{ d.filename }}</span>
                · {{ d.error ?? 'unknown error' }}
              </p>
              <p v-if="failedCount > PREVIEW" class="mt-1 text-xs text-dimmed">
                and {{ failedCount - PREVIEW }} more
              </p>
            </div>
            <UButton to="/downloads" label="View downloads" trailing-icon="i-ph-arrow-right" variant="link" size="sm" class="shrink-0" />
          </div>

          <!-- Size mismatches -->
          <div v-if="mismatchCount" class="flex gap-3 px-4 py-3">
            <UIcon name="i-ph-warning" class="mt-0.5 size-4 shrink-0 text-warning" />
            <div class="min-w-0">
              <p class="text-sm text-default">
                {{ plural(mismatchCount, 'transfer') }} {{ mismatchCount === 1 ? 'reports' : 'report' }} a size mismatch
              </p>
              <p
                v-for="d in mismatches.slice(0, PREVIEW)"
                :key="d.id"
                class="mt-1 truncate text-xs text-muted"
                :title="d.filename"
              >
                <span class="text-toned">{{ d.filename }}</span> · from {{ d.peerName }}
              </p>
              <p v-if="mismatchCount > PREVIEW" class="mt-1 text-xs text-dimmed">
                and {{ mismatchCount - PREVIEW }} more
              </p>
            </div>
          </div>
        </div>
      </template>
    </UCollapsible>
  </UCard>
</template>
