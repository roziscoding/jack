<script setup lang="ts">
import type { ApiKey, ApiKeyInput, CreatedApiKey } from '~/types/management'

const { request, extractError } = useManagement()

const { data, pending, error, refresh } = await useAsyncData('api-keys', () =>
  request<ApiKey[]>('api-keys'))

const keys = computed(() => data.value ?? [])

const showForm = ref(false)
const editTarget = ref<ApiKey | null>(null)
const submitting = ref(false)
const formError = ref<string | null>(null)

// The one-time reveal: set after a successful create, cleared when dismissed.
const created = ref<CreatedApiKey | null>(null)
const copied = ref(false)

const confirmTarget = ref<ApiKey | null>(null)
const revoking = ref(false)
const revokeError = ref<string | null>(null)

// Expiration as an at-a-glance signal rather than a raw timestamp.
function expiryInfo(key: ApiKey): { label: string, tone: 'muted' | 'warn' | 'dead' } {
  if (!key.expiresAt)
    return { label: 'Never expires', tone: 'muted' }
  const ms = new Date(key.expiresAt).getTime() - Date.now()
  if (ms <= 0)
    return { label: 'Expired', tone: 'dead' }
  const days = Math.ceil(ms / 86_400_000)
  if (days <= 7)
    return { label: `Expires in ${days}d`, tone: 'warn' }
  return { label: `Expires ${new Date(key.expiresAt).toLocaleDateString()}`, tone: 'muted' }
}
const toneClass: Record<'muted' | 'warn' | 'dead', string> = {
  muted: 'text-slate-500',
  warn: 'text-amber-300',
  dead: 'text-rose-300',
}

function openAdd() {
  editTarget.value = null
  formError.value = null
  showForm.value = true
}
function openEdit(key: ApiKey) {
  editTarget.value = key
  formError.value = null
  showForm.value = true
}

async function submit(input: ApiKeyInput) {
  submitting.value = true
  formError.value = null
  try {
    if (editTarget.value) {
      await request(`api-keys/${editTarget.value.id}`, { method: 'PATCH', body: input })
      showForm.value = false
    }
    else {
      const key = await request<CreatedApiKey>('api-keys', { method: 'POST', body: input })
      showForm.value = false
      // Hand straight off to the reveal — this is the only chance to copy it.
      created.value = key
    }
    await refresh()
  }
  catch (err) {
    formError.value = extractError(err, 'Could not save the key.')
  }
  finally {
    submitting.value = false
  }
}

async function copyKey() {
  if (!created.value)
    return
  await navigator.clipboard.writeText(created.value.key)
  copied.value = true
  setTimeout(() => (copied.value = false), 2000)
}

function dismissReveal() {
  created.value = null
  copied.value = false
}

function closeConfirm() {
  confirmTarget.value = null
  revokeError.value = null
}
async function confirmRevoke() {
  if (!confirmTarget.value)
    return
  revoking.value = true
  revokeError.value = null
  try {
    await request(`api-keys/${confirmTarget.value.id}`, { method: 'DELETE' })
    confirmTarget.value = null
    await refresh()
  }
  catch (err) {
    revokeError.value = extractError(err, 'Could not revoke the key.')
  }
  finally {
    revoking.value = false
  }
}
</script>

<template>
  <div>
    <PageHeader title="Settings" subtitle="Configure this Jack instance." />

    <section>
      <div class="mb-3 flex items-end justify-between gap-4">
        <div>
          <h2 class="text-sm font-medium text-slate-200">
            API keys
          </h2>
          <p class="mt-0.5 text-xs text-slate-500">
            Keys external tools use to authenticate with Jack's API.
          </p>
        </div>
        <button class="shrink-0 rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-brand-500" @click="openAdd">
          Create key
        </button>
      </div>

      <div v-if="error" class="rounded-xl border border-rose-900/60 bg-rose-950/30 p-4 text-sm text-rose-200">
        Failed to load API keys.
      </div>

      <div v-else-if="pending" class="text-sm text-slate-500">
        Loading…
      </div>

      <div v-else-if="keys.length === 0" class="rounded-xl border border-slate-800 bg-slate-900/40 p-8 text-center text-sm text-slate-500">
        No API keys yet. Create one to let external tools authenticate with Jack.
      </div>

      <div v-else class="space-y-2">
        <div
          v-for="key in keys"
          :key="key.id"
          class="rounded-xl border border-slate-800 bg-slate-900/40 px-4 py-3.5"
        >
          <div class="flex items-center gap-3">
            <div class="min-w-0 flex-1">
              <div class="flex items-baseline gap-2">
                <span v-if="key.name" class="truncate font-medium" :title="key.name">{{ key.name }}</span>
                <span v-else class="truncate font-medium text-slate-500">Unnamed key</span>
                <span class="shrink-0 font-mono text-xs text-slate-600">#{{ key.id }}</span>
              </div>
              <p v-if="key.description" class="truncate text-xs text-slate-500" :title="key.description">
                {{ key.description }}
              </p>
            </div>
            <div class="shrink-0 text-right">
              <p class="text-xs font-medium" :class="toneClass[expiryInfo(key).tone]">
                {{ expiryInfo(key).label }}
              </p>
              <p class="text-xs text-slate-600" :title="formatDate(key.createdAt)">
                Created {{ formatAgo(key.createdAt) }} ago
              </p>
            </div>
            <div class="shrink-0">
              <button class="text-xs font-medium text-slate-400 hover:text-slate-100" @click="openEdit(key)">
                Edit
              </button>
              <button class="ml-3 text-xs font-medium text-slate-400 hover:text-rose-400" @click="confirmTarget = key">
                Revoke
              </button>
            </div>
          </div>
        </div>
      </div>
    </section>

    <Modal v-if="showForm" :title="editTarget ? 'Edit API key' : 'Create API key'" @close="showForm = false">
      <ApiKeyForm
        :initial="editTarget"
        :submitting="submitting"
        :error="formError"
        @submit="submit"
        @cancel="showForm = false"
      />
    </Modal>

    <Modal v-if="created" title="API key created" @close="dismissReveal">
      <div class="space-y-4">
        <div class="rounded-lg border border-amber-900/60 bg-amber-950/30 px-3.5 py-3 text-sm leading-relaxed text-amber-200">
          Copy this key now — it's the only time it's shown. Store it somewhere safe; you won't be able to view it again.
        </div>

        <div>
          <label class="mb-1 block text-sm text-slate-300">{{ created.name || 'Unnamed key' }}</label>
          <div class="flex items-stretch gap-2">
            <code class="min-w-0 flex-1 select-all break-all rounded-lg border border-slate-700 bg-slate-950 px-3 py-2.5 font-mono text-sm text-emerald-300">{{ created.key }}</code>
            <button
              class="shrink-0 rounded-lg bg-brand-600 px-4 text-sm font-medium text-white transition hover:bg-brand-500"
              @click="copyKey"
            >
              {{ copied ? 'Copied' : 'Copy' }}
            </button>
          </div>
        </div>

        <div class="flex justify-end pt-1">
          <button class="rounded-lg bg-slate-800 px-4 py-2 text-sm font-medium text-slate-100 transition hover:bg-slate-700" @click="dismissReveal">
            Done
          </button>
        </div>
      </div>
    </Modal>

    <Modal v-if="confirmTarget" title="Revoke API key" @close="closeConfirm">
      <p class="text-sm text-slate-300">
        Revoke <strong>{{ confirmTarget.name || `key #${confirmTarget.id}` }}</strong>? Any tool using this key
        stops working immediately. This can't be undone.
      </p>
      <p v-if="revokeError" class="mt-3 rounded-lg border border-rose-900/60 bg-rose-950/30 p-3 text-sm text-rose-200">
        {{ revokeError }}
      </p>
      <div class="mt-5 flex justify-end gap-2">
        <button class="rounded-lg px-4 py-2 text-sm text-slate-400 hover:text-slate-100" @click="closeConfirm">
          Cancel
        </button>
        <button
          :disabled="revoking"
          class="rounded-lg bg-rose-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-rose-500 disabled:opacity-50"
          @click="confirmRevoke"
        >
          {{ revoking ? 'Revoking…' : 'Revoke' }}
        </button>
      </div>
    </Modal>
  </div>
</template>
