<script setup lang="ts">
import type { BadgeProps } from '@nuxt/ui'
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
const confirmOpen = computed({
  get: () => confirmTarget.value !== null,
  set: (v) => {
    if (!v)
      closeConfirm()
  },
})

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

function statusBadge(server: ServerItem): { color: BadgeProps['color'], label: string } {
  if (server.initialized)
    return { color: 'success', label: 'Connected' }
  if (server.initializationError)
    return { color: 'error', label: 'Unreachable' }
  return { color: 'warning', label: 'Connecting' }
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
  <section>
    <div class="mb-4 flex items-end justify-between gap-4">
      <div class="flex items-center gap-3">
        <span class="flex size-9 shrink-0 items-center justify-center rounded-lg bg-elevated">
          <UIcon name="i-ph-hard-drives" class="size-5 text-muted" />
        </span>
        <div>
          <h2 class="text-sm font-semibold text-highlighted">
            Servers
          </h2>
          <p class="text-xs text-muted">
            Radarr / Sonarr instances jack reads from and pushes to.
          </p>
        </div>
      </div>
      <UButton label="Add server" icon="i-ph-plus" class="shrink-0" @click="openAdd" />
    </div>

    <UAlert v-if="error" color="error" variant="soft" icon="i-ph-warning" title="Failed to load servers." />

    <p v-else-if="pending" class="flex items-center gap-2 text-sm text-muted">
      <UIcon name="i-ph-circle-notch" class="size-4 animate-spin" />
      Loading…
    </p>

    <UCard v-else-if="data && data.servers.length === 0" variant="subtle">
      <div class="flex flex-col items-center gap-3 py-6 text-center">
        <UIcon name="i-ph-hard-drives" class="size-8 text-dimmed" />
        <p class="text-sm text-muted">
          No servers yet. Add a Radarr or Sonarr instance for jack to read from and push to.
        </p>
        <UButton label="Add server" icon="i-ph-plus" @click="openAdd" />
      </div>
    </UCard>

    <div v-else-if="data" class="space-y-3">
      <p class="text-xs tabular-nums text-muted">
        {{ connected }} of {{ servers.length }} connected<template v-if="unreachable">
          · <span class="text-error">{{ unreachable }} unreachable</span>
        </template>
        · {{ sources }} {{ sources === 1 ? 'source' : 'sources' }}
        · {{ destinations }} {{ destinations === 1 ? 'destination' : 'destinations' }}
      </p>

      <div class="space-y-2">
        <ConnectorCard
          v-for="server in servers"
          :key="server.id"
          :name="server.name"
          :url="server.url"
          :initialized="server.initialized"
          :error="server.initializationError"
          :status="statusBadge(server)"
          @edit="openEdit(server)"
          @remove="confirmTarget = server"
        >
          <template #badge>
            <UBadge color="neutral" variant="subtle" size="sm" class="capitalize" :label="server.type" />
          </template>
          <template #meta>
            <div class="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 pl-8 text-xs text-muted">
              <span>{{ roleLabel(server) }}</span>
              <span class="text-dimmed">·</span>
              <span v-if="server.autoregister.enable">auto-registers with priority {{ server.autoregister.priority }}</span>
              <span v-else>manual registration</span>
            </div>
          </template>
        </ConnectorCard>
      </div>
    </div>
  </section>

  <UModal v-model:open="showForm" :title="editTarget ? 'Edit server' : 'Add server'">
    <template #body>
      <ServerForm
        :initial="editTarget"
        :submitting="submitting"
        :error="formError"
        @submit="submit"
        @cancel="showForm = false"
      />
    </template>
  </UModal>

  <UModal v-model:open="confirmOpen" title="Remove server" :ui="{ footer: 'justify-end' }">
    <template #body>
      <p class="text-sm text-default">
        Remove <strong>{{ confirmTarget?.name }}</strong>? jack stops reading from / pushing to it.
        The indexer/client already registered inside *arr is not removed automatically.
      </p>
      <UAlert v-if="deleteError" class="mt-3" color="error" variant="soft" icon="i-ph-warning" :title="deleteError" />
    </template>
    <template #footer="{ close }">
      <UButton label="Cancel" color="neutral" variant="ghost" @click="close" />
      <UButton label="Remove" color="error" :loading="deleting" @click="confirmDelete" />
    </template>
  </UModal>
</template>
