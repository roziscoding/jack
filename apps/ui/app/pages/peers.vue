<script setup lang="ts">
import type { PeerInput, PeerItem } from '~/types/management'

const { request, extractError } = useManagement()

const { data, pending, error, refresh } = await useAsyncData('peers', () =>
  request<{ peers: PeerItem[] }>('config/peers'))

const showForm = ref(false)
const editTarget = ref<PeerItem | null>(null)
const submitting = ref(false)
const formError = ref<string | null>(null)

const confirmTarget = ref<PeerItem | null>(null)
const deleting = ref(false)
const deleteError = ref<string | null>(null)

// Surface trouble first: unreachable peers sort to the top, then connecting,
// then healthy — so the ones you might need to fix are never buried.
function sortKey(peer: PeerItem) {
  if (!peer.initialized && peer.initializationError)
    return 0
  if (!peer.initialized)
    return 1
  return 2
}
const peers = computed(() => [...(data.value?.peers ?? [])].sort((a, b) => sortKey(a) - sortKey(b)))
const connected = computed(() => peers.value.filter(p => p.initialized).length)
const unreachable = computed(() => peers.value.filter(p => !p.initialized && p.initializationError).length)

function closeConfirm() {
  confirmTarget.value = null
  deleteError.value = null
}

function openAdd() {
  editTarget.value = null
  formError.value = null
  showForm.value = true
}
function openEdit(peer: PeerItem) {
  editTarget.value = peer
  formError.value = null
  showForm.value = true
}

async function submit(input: PeerInput, force = false) {
  submitting.value = true
  formError.value = null
  // force (shift-click): persist the peer even if its handshake fails — the
  // backend keeps it resident and retries lazily instead of rejecting the add.
  const query = force ? { force: 'true' } : undefined
  try {
    if (editTarget.value)
      await request(`config/peers/${editTarget.value.id}`, { method: 'PATCH', body: input, query })
    else
      await request('config/peers', { method: 'POST', body: input, query })
    showForm.value = false
    await refresh()
  }
  catch (err) {
    formError.value = extractError(err, 'Could not save the peer.')
  }
  finally {
    submitting.value = false
  }
}

async function confirmDelete() {
  if (!confirmTarget.value)
    return
  deleting.value = true
  deleteError.value = null
  try {
    await request(`config/peers/${confirmTarget.value.id}`, { method: 'DELETE' })
    confirmTarget.value = null
    await refresh()
  }
  catch (err) {
    deleteError.value = extractError(err, 'Could not remove the peer.')
  }
  finally {
    deleting.value = false
  }
}
</script>

<template>
  <div>
    <PageHeader title="Peers" subtitle="Other jacks this instance federates with.">
      <template #actions>
        <button class="rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-brand-500" @click="openAdd">
          Add peer
        </button>
      </template>
    </PageHeader>

    <div v-if="error" class="rounded-xl border border-rose-900/60 bg-rose-950/30 p-4 text-sm text-rose-200">
      Failed to load peers.
    </div>

    <div v-else-if="pending" class="text-sm text-slate-500">
      Loading…
    </div>

    <div v-else-if="data && data.peers.length === 0" class="rounded-xl border border-slate-800 bg-slate-900/40 p-8 text-center text-sm text-slate-500">
      No peers yet. Add a friend's jack to start pulling from their library.
    </div>

    <div v-else-if="data">
      <p class="mb-3 text-xs tabular-nums text-slate-500">
        {{ connected }} of {{ peers.length }} connected<template v-if="unreachable">
          · <span class="text-rose-300">{{ unreachable }} unreachable</span>
        </template>
      </p>

      <div class="space-y-2">
        <div
          v-for="peer in peers"
          :key="peer.id"
          class="rounded-xl border border-slate-800 bg-slate-900/40 px-4 py-3.5"
        >
          <div class="flex items-center gap-3">
            <ConnDot :initialized="peer.initialized" :error="peer.initializationError" />
            <div class="min-w-0 flex-1">
              <div class="flex items-baseline gap-2">
                <span class="truncate font-medium" :title="peer.name">{{ peer.name }}</span>
                <span v-if="peer.version" class="shrink-0 text-xs tabular-nums text-slate-500">v{{ peer.version }}</span>
              </div>
              <p class="truncate font-mono text-xs text-slate-500" :title="peer.url">
                {{ peer.url }}
              </p>
            </div>
            <span
              class="shrink-0 text-xs font-medium"
              :class="peer.initialized ? 'text-emerald-400' : peer.initializationError ? 'text-rose-300' : 'text-amber-300'"
            >
              {{ peer.initialized ? 'Connected' : peer.initializationError ? 'Unreachable' : 'Connecting' }}
            </span>
            <div class="shrink-0">
              <button class="text-xs font-medium text-slate-400 hover:text-slate-100" @click="openEdit(peer)">
                Edit
              </button>
              <button class="ml-3 text-xs font-medium text-slate-400 hover:text-rose-400" @click="confirmTarget = peer">
                Remove
              </button>
            </div>
          </div>

          <p
            v-if="!peer.initialized && peer.initializationError"
            class="mt-2.5 rounded-lg border border-rose-900/50 bg-rose-950/30 px-3 py-2 font-mono text-xs text-rose-300"
          >
            {{ peer.initializationError }}
          </p>
        </div>
      </div>
    </div>

    <Modal v-if="showForm" :title="editTarget ? 'Edit peer' : 'Add peer'" @close="showForm = false">
      <PeerForm
        :initial="editTarget"
        :submitting="submitting"
        :error="formError"
        @submit="submit"
        @cancel="showForm = false"
      />
    </Modal>

    <Modal v-if="confirmTarget" title="Remove peer" @close="closeConfirm">
      <p class="text-sm text-slate-300">
        Remove <strong>{{ confirmTarget.name }}</strong>? In-flight downloads finish; new
        searches stop hitting it immediately.
      </p>
      <p v-if="deleteError" class="mt-3 rounded-lg border border-rose-900/60 bg-rose-950/30 p-3 text-sm text-rose-200">
        {{ deleteError }}
      </p>
      <div class="mt-5 flex justify-end gap-2">
        <button class="rounded-lg px-4 py-2 text-sm text-slate-400 hover:text-slate-100" @click="closeConfirm">
          Cancel
        </button>
        <button
          :disabled="deleting"
          class="rounded-lg bg-rose-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-rose-500 disabled:opacity-50"
          @click="confirmDelete"
        >
          {{ deleting ? 'Removing…' : 'Remove' }}
        </button>
      </div>
    </Modal>
  </div>
</template>
