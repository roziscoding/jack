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

const collapsed = ref(false)
onMounted(() => {
  collapsed.value = localStorage.getItem(STORAGE_KEY) === '1'
})
watch(collapsed, (v) => {
  localStorage.setItem(STORAGE_KEY, v ? '1' : '0')
})

function plural(n: number, word: string) {
  return `${n} ${word}${n === 1 ? '' : 's'}`
}
</script>

<template>
  <!-- All clear: one calm line, nothing to collapse. -->
  <div
    v-if="!hasIssues"
    class="flex items-center gap-2.5 rounded-xl border border-slate-800 bg-slate-900/40 p-4 text-sm text-slate-300"
  >
    <span class="text-emerald-400">✓</span>
    Everything's connected and nothing's failing.
  </div>

  <!-- Something needs doing. -->
  <div v-else class="overflow-hidden rounded-xl border border-slate-800 bg-slate-900/40">
    <button
      type="button"
      class="flex w-full items-center gap-3 px-4 py-3.5 text-left transition hover:bg-slate-800/30"
      :aria-expanded="!collapsed"
      aria-controls="attention-body"
      @click="collapsed = !collapsed"
    >
      <span
        class="text-xs text-slate-500 transition-transform"
        :class="collapsed ? '-rotate-90' : ''"
      >▾</span>
      <span class="text-sm font-semibold text-slate-200">Needs attention</span>
      <span class="ml-auto rounded-full border border-rose-900/50 bg-rose-950/60 px-2 py-0.5 text-xs font-semibold text-rose-300">
        {{ plural(issueCount, 'issue') }}
      </span>
    </button>

    <div v-show="!collapsed" id="attention-body" class="divide-y divide-slate-800/60 border-t border-slate-800">
      <!-- Unreachable peers -->
      <div v-for="peer in unreachablePeers" :key="`peer-${peer.id}`" class="flex gap-3 px-4 py-3">
        <span class="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-rose-400" />
        <p class="min-w-0 text-sm text-slate-200">
          <span class="font-semibold">{{ peer.name }}</span> peer unreachable<template v-if="peer.initializationError">
            — <span class="font-mono text-xs text-rose-300">{{ peer.initializationError }}</span>
          </template>
        </p>
      </div>

      <!-- Unreachable servers -->
      <div v-for="server in unreachableServers" :key="`server-${server.id}`" class="flex gap-3 px-4 py-3">
        <span class="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-rose-400" />
        <p class="min-w-0 text-sm text-slate-200">
          <span class="font-semibold">{{ server.name }}</span> server unreachable<template v-if="server.initializationError">
            — <span class="font-mono text-xs text-rose-300">{{ server.initializationError }}</span>
          </template>
        </p>
      </div>

      <!-- Stuck imports -->
      <div v-if="queuedCount" class="flex gap-3 px-4 py-3">
        <span class="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-amber-400" />
        <div class="min-w-0">
          <p class="text-sm text-slate-200">
            {{ plural(queuedCount, 'download') }} waiting for *arr to import
          </p>
          <p
            v-for="d in stuckImports.slice(0, PREVIEW)"
            :key="d.id"
            class="mt-1 truncate text-xs text-slate-500"
            :title="d.filename"
          >
            <span class="text-slate-400">{{ d.filename }}</span>
            · from {{ d.peerName }}
            · waiting {{ formatAgo(d.completedAt ?? d.updatedAt) }}
          </p>
          <p v-if="queuedCount > PREVIEW" class="mt-1 text-xs text-slate-600">
            and {{ queuedCount - PREVIEW }} more
          </p>
        </div>
      </div>

      <!-- Failed downloads -->
      <div v-if="failedCount" class="flex items-start gap-3 px-4 py-3">
        <span class="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-rose-400" />
        <div class="min-w-0 flex-1">
          <p class="text-sm text-slate-200">
            {{ plural(failedCount, 'download') }} failed
          </p>
          <p
            v-for="d in failed.slice(0, PREVIEW)"
            :key="d.id"
            class="mt-1 truncate text-xs text-slate-500"
            :title="d.error ?? undefined"
          >
            <span class="text-slate-400">{{ d.filename }}</span>
            · {{ d.error ?? 'unknown error' }}
          </p>
          <p v-if="failedCount > PREVIEW" class="mt-1 text-xs text-slate-600">
            and {{ failedCount - PREVIEW }} more
          </p>
        </div>
        <NuxtLink to="/downloads" class="shrink-0 text-sm text-brand-400 hover:text-brand-300">
          View downloads →
        </NuxtLink>
      </div>

      <!-- Size mismatches -->
      <div v-if="mismatchCount" class="flex gap-3 px-4 py-3">
        <span class="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-amber-400" />
        <div class="min-w-0">
          <p class="text-sm text-slate-200">
            {{ plural(mismatchCount, 'transfer') }} {{ mismatchCount === 1 ? 'reports' : 'report' }} a size mismatch
          </p>
          <p
            v-for="d in mismatches.slice(0, PREVIEW)"
            :key="d.id"
            class="mt-1 truncate text-xs text-slate-500"
            :title="d.filename"
          >
            <span class="text-slate-400">{{ d.filename }}</span> · from {{ d.peerName }}
          </p>
          <p v-if="mismatchCount > PREVIEW" class="mt-1 text-xs text-slate-600">
            and {{ mismatchCount - PREVIEW }} more
          </p>
        </div>
      </div>
    </div>
  </div>
</template>
