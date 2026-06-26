<script setup lang="ts">
import type { BadgeProps } from '@nuxt/ui'
import type { ApiKey, ApiKeyInput, CreatedApiKey, JackConfig } from '~/types/management'

const { request, extractError } = useManagement()

const { data, pending, error, refresh } = await useAsyncData('api-keys', () =>
  request<ApiKey[]>('api-keys'))

const keys = computed(() => data.value ?? [])

// Jack config (config.jack). Separate async key from the api-keys load above.
// Surface pending/error so a failed GET never renders a blank form a user could
// accidentally save over (mirrors the api-keys load states below).
const { data: jack, pending: jackPending, error: jackLoadError, refresh: refreshJack }
  = await useAsyncData('jack-config', () => request<JackConfig | null>('config/jack'))

// Whether the running TMDB key authenticates — surfaced beside the key field so a
// saved key can be confirmed at a glance.
const { data: tmdbStatus } = await useAsyncData('tmdb-status', () =>
  request<{ configured: boolean, ok: boolean }>('catalog/tmdb/status'))

const jackSubmitting = ref(false)
const jackError = ref<string | null>(null)
const jackSaved = ref(false)

async function saveJack(input: JackConfig) {
  jackSubmitting.value = true
  jackError.value = null
  jackSaved.value = false
  try {
    await request('config/jack', { method: 'PATCH', body: input })
    await refreshJack()
    // jack values are captured at boot, so the change lands on next restart.
    jackSaved.value = true
  }
  catch (err) {
    jackError.value = extractError(err, 'Could not save the Jack config.')
  }
  finally {
    jackSubmitting.value = false
  }
}

const showForm = ref(false)
const editTarget = ref<ApiKey | null>(null)
const submitting = ref(false)
const formError = ref<string | null>(null)

// The one-time reveal: set after a successful create, cleared when dismissed.
const created = ref<CreatedApiKey | null>(null)
const createdOpen = computed({
  get: () => created.value !== null,
  set: (v) => {
    if (!v)
      dismissReveal()
  },
})
const copied = ref(false)

const confirmTarget = ref<ApiKey | null>(null)
const revoking = ref(false)
const revokeError = ref<string | null>(null)
const confirmOpen = computed({
  get: () => confirmTarget.value !== null,
  set: (v) => {
    if (!v)
      closeConfirm()
  },
})

// Expiration as an at-a-glance signal rather than a raw timestamp.
function expiryInfo(key: ApiKey): { label: string, color: BadgeProps['color'] } {
  if (!key.expiresAt)
    return { label: 'Never expires', color: 'neutral' }
  const ms = new Date(key.expiresAt).getTime() - Date.now()
  if (ms <= 0)
    return { label: 'Expired', color: 'error' }
  const days = Math.ceil(ms / 86_400_000)
  if (days <= 7)
    return { label: `Expires in ${days}d`, color: 'warning' }
  return { label: `Expires ${new Date(key.expiresAt).toLocaleDateString()}`, color: 'neutral' }
}

// One muted meta line per key: its description (if any) then when it was created.
function keyMeta(key: ApiKey): string {
  const created = `Created ${formatAgo(key.createdAt)} ago`
  return key.description ? `${key.description} · ${created}` : created
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
  <UDashboardPanel id="settings">
    <template #header>
      <UDashboardNavbar title="Settings" />
    </template>

    <template #body>
      <div class="space-y-10">
        <!-- Jack -->
        <SettingsSection
          title="Jack"
          description="How this instance presents itself to your *arr apps. Changes apply after a restart."
        >
          <UAlert v-if="jackLoadError" color="error" variant="soft" icon="i-ph-warning" title="Failed to load the Jack config." />

          <p v-else-if="jackPending" class="flex items-center gap-2 text-sm text-muted">
            <UIcon name="i-ph-circle-notch" class="size-4 animate-spin" />
            Loading…
          </p>

          <UCard v-else variant="subtle" :ui="{ body: 'space-y-4' }">
            <!-- Re-key on the loaded internalUrl so the form (and SecretInput) seed
                 their once-initialized local state from the resolved data. -->
            <JackConfigForm
              :key="jack?.internalUrl ?? 'empty'"
              :initial="jack"
              :submitting="jackSubmitting"
              :error="jackError"
              @submit="saveJack"
            />
            <UAlert
              v-if="jackSaved"
              color="success"
              variant="soft"
              icon="i-ph-check-circle"
              title="Saved. Restart the server for the change to take effect."
            />
            <p class="flex items-center gap-2 text-xs">
              <template v-if="tmdbStatus?.ok">
                <UIcon name="i-ph-check-circle" class="size-4 text-success" />
                <span class="text-muted">TMDB connected.</span>
              </template>
              <template v-else-if="tmdbStatus?.configured">
                <UIcon name="i-ph-warning" class="size-4 text-warning" />
                <span class="text-muted">TMDB key set but not authenticating.</span>
              </template>
              <template v-else>
                <UIcon name="i-ph-info" class="size-4 text-dimmed" />
                <span class="text-muted">TMDB not configured — peer catalogs show names only.</span>
              </template>
            </p>
          </UCard>
        </SettingsSection>

        <USeparator />

        <PeersSection />

        <USeparator />

        <ServersSection />

        <USeparator />

        <!-- API keys -->
        <SettingsSection
          title="API keys"
          description="Keys external tools use to authenticate with Jack's API."
        >
          <template #aside>
            <UButton label="Create key" icon="i-ph-plus" @click="openAdd" />
          </template>

          <UAlert v-if="error" color="error" variant="soft" icon="i-ph-warning" title="Failed to load API keys." />

          <p v-else-if="pending" class="flex items-center gap-2 text-sm text-muted">
            <UIcon name="i-ph-circle-notch" class="size-4 animate-spin" />
            Loading…
          </p>

          <UCard v-else-if="keys.length === 0" variant="subtle">
            <div class="flex flex-col items-center gap-3 py-6 text-center">
              <UIcon name="i-ph-key" class="size-8 text-dimmed" />
              <p class="text-sm text-muted">
                No API keys yet. Create one to let external tools authenticate with Jack.
              </p>
              <UButton label="Create key" icon="i-ph-plus" @click="openAdd" />
            </div>
          </UCard>

          <div v-else class="space-y-2">
            <UCard v-for="key in keys" :key="key.id" variant="subtle" :ui="{ body: 'sm:p-4' }">
              <div class="flex items-center gap-3">
                <span class="flex size-9 shrink-0 items-center justify-center rounded-lg bg-elevated">
                  <UIcon name="i-ph-key" class="size-4 text-muted" />
                </span>
                <div class="min-w-0 flex-1">
                  <div class="flex items-baseline gap-2">
                    <span v-if="key.name" class="truncate font-medium text-default" :title="key.name">{{ key.name }}</span>
                    <span v-else class="truncate font-medium text-muted">Unnamed key</span>
                    <span class="shrink-0 font-mono text-xs text-dimmed">#{{ key.id }}</span>
                  </div>
                  <p class="truncate text-xs text-muted" :title="formatDate(key.createdAt)">
                    {{ keyMeta(key) }}
                  </p>
                </div>
                <UBadge v-bind="expiryInfo(key)" variant="subtle" />
                <UButton icon="i-ph-pencil-simple" color="neutral" variant="ghost" size="sm" aria-label="Edit key" @click="openEdit(key)" />
                <UButton icon="i-ph-trash" color="neutral" variant="ghost" size="sm" aria-label="Revoke key" @click="confirmTarget = key" />
              </div>
            </UCard>
          </div>
        </SettingsSection>
      </div>
    </template>
  </UDashboardPanel>

  <UModal v-model:open="showForm" :title="editTarget ? 'Edit API key' : 'Create API key'">
    <template #body>
      <ApiKeyForm
        :initial="editTarget"
        :submitting="submitting"
        :error="formError"
        @submit="submit"
        @cancel="showForm = false"
      />
    </template>
  </UModal>

  <UModal v-model:open="createdOpen" title="API key created" :ui="{ footer: 'justify-end' }">
    <template #body>
      <div class="space-y-4">
        <UAlert
          color="warning"
          variant="soft"
          icon="i-ph-warning"
          title="Copy this key now"
          description="It's the only time it's shown. Store it somewhere safe; you won't be able to view it again."
        />

        <UFormField :label="created?.name || 'Unnamed key'">
          <UButtonGroup class="w-full">
            <UInput :model-value="created?.key" readonly class="flex-1 font-mono" :ui="{ base: 'text-success' }" />
            <UButton
              :icon="copied ? 'i-ph-check' : 'i-ph-copy'"
              :color="copied ? 'success' : 'neutral'"
              variant="subtle"
              :label="copied ? 'Copied' : 'Copy'"
              @click="copyKey"
            />
          </UButtonGroup>
        </UFormField>
      </div>
    </template>
    <template #footer="{ close }">
      <UButton label="Done" color="neutral" @click="close" />
    </template>
  </UModal>

  <UModal v-model:open="confirmOpen" title="Revoke API key" :ui="{ footer: 'justify-end' }">
    <template #body>
      <p class="text-sm text-default">
        Revoke <strong>{{ confirmTarget?.name || `key #${confirmTarget?.id}` }}</strong>? Any tool using this key
        stops working immediately. This can't be undone.
      </p>
      <UAlert v-if="revokeError" class="mt-3" color="error" variant="soft" icon="i-ph-warning" :title="revokeError" />
    </template>
    <template #footer="{ close }">
      <UButton label="Cancel" color="neutral" variant="ghost" @click="close" />
      <UButton label="Revoke" color="error" :loading="revoking" @click="confirmRevoke" />
    </template>
  </UModal>
</template>
