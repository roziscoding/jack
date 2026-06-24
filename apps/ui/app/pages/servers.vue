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
  deleteError.value = null
  try {
    await request(`config/servers/${confirmTarget.value.id}`, { method: 'DELETE' })
    confirmTarget.value = null
    await refresh()
  }
  catch (err) {
    deleteError.value = extractError(err, 'Could not remove the server.')
  }
  finally {
    deleting.value = false
  }
}

function roleLabel(server: ServerItem): string {
  const roles = [server.source && 'source', server.destination && 'destination'].filter(Boolean)
  return roles.length ? roles.join(' · ') : 'disabled'
}

// Unreachable servers first (a broken *arr connector stops searches/imports),
// then connecting, then healthy.
function sortKey(server: ServerItem) {
  if (!server.initialized && server.initializationError)
    return 0
  if (!server.initialized)
    return 1
  return 2
}
const servers = computed(() => [...(data.value?.servers ?? [])].sort((a, b) => sortKey(a) - sortKey(b)))
const connected = computed(() => servers.value.filter(s => s.initialized).length)
const unreachable = computed(() => servers.value.filter(s => !s.initialized && s.initializationError).length)
const sources = computed(() => servers.value.filter(s => s.source).length)
const destinations = computed(() => servers.value.filter(s => s.destination).length)
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
      No servers yet. Add a Radarr or Sonarr instance for jack to read from and push to.
    </div>

    <div v-else-if="data">
      <p class="mb-3 text-xs tabular-nums text-slate-500">
        {{ connected }} of {{ servers.length }} connected<template v-if="unreachable">
          · <span class="text-rose-300">{{ unreachable }} unreachable</span>
        </template>
        · {{ sources }} {{ sources === 1 ? 'source' : 'sources' }}
        · {{ destinations }} {{ destinations === 1 ? 'destination' : 'destinations' }}
      </p>

      <div class="space-y-2">
        <div
          v-for="server in servers"
          :key="server.id"
          class="rounded-xl border border-slate-800 bg-slate-900/40 px-4 py-3.5"
        >
          <div class="flex items-center gap-3">
            <ConnDot :initialized="server.initialized" :error="server.initializationError" />
            <div class="min-w-0 flex-1">
              <div class="flex items-baseline gap-2">
                <span class="truncate font-medium" :title="server.name">{{ server.name }}</span>
                <span class="shrink-0 rounded-full bg-slate-800 px-2 py-0.5 text-xs capitalize text-slate-400">{{ server.type }}</span>
              </div>
              <p class="truncate font-mono text-xs text-slate-500" :title="server.url">
                {{ server.url }}
              </p>
            </div>
            <span
              class="shrink-0 text-xs font-medium"
              :class="server.initialized ? 'text-emerald-400' : server.initializationError ? 'text-rose-300' : 'text-amber-300'"
            >
              {{ server.initialized ? 'Connected' : server.initializationError ? 'Unreachable' : 'Connecting' }}
            </span>
            <div class="shrink-0">
              <button class="text-xs font-medium text-slate-400 hover:text-slate-100" @click="openEdit(server)">
                Edit
              </button>
              <button class="ml-3 text-xs font-medium text-slate-400 hover:text-rose-400" @click="confirmTarget = server">
                Remove
              </button>
            </div>
          </div>

          <div class="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 pl-[1.625rem] text-xs text-slate-500">
            <span>{{ roleLabel(server) }}</span>
            <span class="text-slate-700">·</span>
            <span v-if="server.autoregister.enable">auto-registers with priority {{ server.autoregister.priority }}</span>
            <span v-else>manual registration</span>
          </div>

          <p
            v-if="!server.initialized && server.initializationError"
            class="mt-2.5 rounded-lg border border-rose-900/50 bg-rose-950/30 px-3 py-2 font-mono text-xs text-rose-300"
          >
            {{ server.initializationError }}
          </p>
        </div>
      </div>
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

    <Modal v-if="confirmTarget" title="Remove server" @close="closeConfirm">
      <p class="text-sm text-slate-300">
        Remove <strong>{{ confirmTarget.name }}</strong>? jack stops reading from / pushing to it.
        The indexer/client already registered inside *arr is not removed automatically.
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
