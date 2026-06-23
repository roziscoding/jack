<script setup lang="ts">
import type { ServerInput, ServerItem } from '~/types/management'

const { request, extractError } = useManagement()

const { data, pending, error, refresh } = await useAsyncData('servers', () =>
  request<{ servers: ServerItem[] }>('config/servers'))

const showForm = ref(false)
const editTarget = ref<ServerItem | null>(null)
const submitting = ref(false)
const formError = ref<string | null>(null)

const confirmTarget = ref<ServerItem | null>(null)
const deleting = ref(false)

function openAdd() {
  editTarget.value = null
  formError.value = null
  showForm.value = true
}
function openEdit(server: ServerItem) {
  editTarget.value = server
  formError.value = null
  showForm.value = true
}

async function submit(input: ServerInput) {
  submitting.value = true
  formError.value = null
  try {
    if (editTarget.value)
      await request(`config/servers/${editTarget.value.id}`, { method: 'PATCH', body: input })
    else
      await request('config/servers', { method: 'POST', body: input })
    showForm.value = false
    await refresh()
  }
  catch (err) {
    formError.value = extractError(err, 'Could not save the server.')
  }
  finally {
    submitting.value = false
  }
}

async function confirmDelete() {
  if (!confirmTarget.value)
    return
  deleting.value = true
  try {
    await request(`config/servers/${confirmTarget.value.id}`, { method: 'DELETE' })
    confirmTarget.value = null
    await refresh()
  }
  finally {
    deleting.value = false
  }
}

function roleLabel(server: ServerItem): string {
  const roles = [server.source && 'source', server.destination && 'destination'].filter(Boolean)
  return roles.length ? roles.join(' · ') : 'disabled'
}
</script>

<template>
  <div>
    <PageHeader title="Servers" subtitle="Radarr / Sonarr instances jack reads from and pushes to.">
      <template #actions>
        <button class="rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-brand-500" @click="openAdd">
          Add server
        </button>
      </template>
    </PageHeader>

    <div v-if="error" class="rounded-xl border border-rose-900/60 bg-rose-950/30 p-4 text-sm text-rose-200">
      Failed to load servers.
    </div>

    <div v-else-if="pending" class="text-sm text-slate-500">
      Loading…
    </div>

    <div v-else-if="data && data.servers.length === 0" class="rounded-xl border border-slate-800 bg-slate-900/40 p-8 text-center text-sm text-slate-500">
      No servers configured yet.
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
              Type
            </th>
            <th class="px-4 py-3 font-medium">
              Roles
            </th>
            <th class="px-4 py-3 font-medium">
              Status
            </th>
            <th class="px-4 py-3" />
          </tr>
        </thead>
        <tbody class="divide-y divide-slate-800">
          <tr v-for="server in data.servers" :key="server.id" class="bg-slate-900/20">
            <td class="px-4 py-3 font-medium">
              {{ server.name }}
            </td>
            <td class="px-4 py-3 text-slate-400">
              {{ server.url }}
            </td>
            <td class="px-4 py-3 capitalize text-slate-400">
              {{ server.type }}
            </td>
            <td class="px-4 py-3 text-slate-400">
              {{ roleLabel(server) }}
            </td>
            <td class="px-4 py-3">
              <StatusBadge :initialized="server.initialized" :error="server.initializationError" />
            </td>
            <td class="px-4 py-3 text-right">
              <button class="text-xs font-medium text-slate-400 hover:text-slate-100" @click="openEdit(server)">
                Edit
              </button>
              <button class="ml-3 text-xs font-medium text-slate-400 hover:text-rose-400" @click="confirmTarget = server">
                Remove
              </button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <Modal v-if="showForm" :title="editTarget ? 'Edit server' : 'Add server'" @close="showForm = false">
      <ServerForm
        :initial="editTarget"
        :submitting="submitting"
        :error="formError"
        @submit="submit"
        @cancel="showForm = false"
      />
    </Modal>

    <Modal v-if="confirmTarget" title="Remove server" @close="confirmTarget = null">
      <p class="text-sm text-slate-300">
        Remove <strong>{{ confirmTarget.name }}</strong>? jack stops reading from / pushing to it.
        The indexer/client already registered inside *arr is not removed automatically.
      </p>
      <div class="mt-5 flex justify-end gap-2">
        <button class="rounded-lg px-4 py-2 text-sm text-slate-400 hover:text-slate-100" @click="confirmTarget = null">
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
