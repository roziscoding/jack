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
      No peers configured yet.
    </div>

    <div v-else-if="data" class="overflow-hidden rounded-xl border border-slate-800">
      <table class="w-full text-left text-sm">
        <thead class="bg-slate-900/60 text-xs uppercase tracking-wide text-slate-500">
          <tr>
            <th class="px-4 py-3 font-medium">
              Name
            </th>
            <th class="px-4 py-3 font-medium">
              URL
            </th>
            <th class="px-4 py-3 font-medium">
              Status
            </th>
            <th class="px-4 py-3 font-medium">
              Version
            </th>
            <th class="px-4 py-3" />
          </tr>
        </thead>
        <tbody class="divide-y divide-slate-800">
          <tr v-for="peer in data.peers" :key="peer.id" class="bg-slate-900/20">
            <td class="px-4 py-3 font-medium">
              {{ peer.name }}
            </td>
            <td class="px-4 py-3 text-slate-400">
              {{ peer.url }}
            </td>
            <td class="px-4 py-3">
              <StatusBadge :initialized="peer.initialized" :error="peer.initializationError" />
            </td>
            <td class="px-4 py-3 text-slate-400">
              {{ peer.version ?? '—' }}
            </td>
            <td class="px-4 py-3 text-right">
              <button class="text-xs font-medium text-slate-400 hover:text-slate-100" @click="openEdit(peer)">
                Edit
              </button>
              <button class="ml-3 text-xs font-medium text-slate-400 hover:text-rose-400" @click="confirmTarget = peer">
                Remove
              </button>
            </td>
          </tr>
        </tbody>
      </table>
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
