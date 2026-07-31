<script setup lang="ts">
import type { FormError } from '@nuxt/ui'
import type { DownloadsConfig, DownloadsConfigPatch } from '~/types/management'

const { request, extractError } = useManagement()

// `null` is a real answer here: no downloads block in the config file, i.e. this
// instance only shares its library and never pulls — there is nothing to configure.
const { data: downloads, pending, error: loadError, refresh } = useLazyAsyncData(
  'downloads-config',
  () => request<DownloadsConfig | null>('config/downloads'),
)

// Every tuning knob is `number | null`, where null means "absent from the file" and
// jack's default applies. The switch has no such state — absent and false behave the
// same, so it stays a plain boolean and is written as an absent key when off.
function blankState() {
  return {
    completedPath: '',
    maxConcurrentDownloads: null as number | null,
    maxDownloadAttempts: null as number | null,
    retryBaseDelayMs: null as number | null,
    retryMaxDelayMs: null as number | null,
    idleTimeoutMs: null as number | null,
    importPollIntervalMs: null as number | null,
    maxManualImportAttempts: null as number | null,
    manualImportBackoffBaseMs: null as number | null,
    manualImportBackoffMaxMs: null as number | null,
    unlinkImportedFiles: false,
  }
}

type State = ReturnType<typeof blankState>

const state = reactive(blankState())
// Snapshot of the last loaded/saved values, so Save stays disabled until something
// actually differs and Revert has somewhere to go back to.
const baseline = ref(JSON.stringify(blankState()))

function seed(config: DownloadsConfig | null | undefined) {
  Object.assign(state, blankState())
  if (config) {
    for (const key of Object.keys(state) as Array<keyof State>) {
      const value = config[key]
      if (value != null)
        (state as Record<string, unknown>)[key] = value
    }
  }
  baseline.value = JSON.stringify(state)
}

watch(() => downloads.value, seed, { immediate: true })

const dirty = computed(() => JSON.stringify(state) !== baseline.value)

const saving = ref(false)
const saveError = ref<string | null>(null)
const saved = ref(false)
// Editing again makes the "Saved" confirmation stale, so retire it on the next change.
watch(dirty, (isDirty) => {
  if (isDirty)
    saved.value = false
})

// A config file with no downloads block gets an invitation to add one rather than a
// dead end — writing the block is exactly what this form does.
const adding = ref(false)
// Set when the save that just succeeded is the one that created the block: nothing
// downloads until the server restarts, which is worth saying plainly.
const justAdded = ref(false)

function validate(s: State): FormError[] {
  if (!s.completedPath.trim())
    return [{ name: 'completedPath', message: 'Enter the folder where finished downloads land.' }]
  return []
}

async function save() {
  saving.value = true
  saveError.value = null
  saved.value = false
  const patch: DownloadsConfigPatch = {
    completedPath: state.completedPath.trim(),
    maxConcurrentDownloads: state.maxConcurrentDownloads,
    maxDownloadAttempts: state.maxDownloadAttempts,
    retryBaseDelayMs: state.retryBaseDelayMs,
    retryMaxDelayMs: state.retryMaxDelayMs,
    idleTimeoutMs: state.idleTimeoutMs,
    importPollIntervalMs: state.importPollIntervalMs,
    maxManualImportAttempts: state.maxManualImportAttempts,
    manualImportBackoffBaseMs: state.manualImportBackoffBaseMs,
    manualImportBackoffMaxMs: state.manualImportBackoffMaxMs,
    // Off is the default, so write it as an absent key rather than an explicit false.
    unlinkImportedFiles: state.unlinkImportedFiles ? true : null,
  }
  const creating = !downloads.value
  try {
    await request('config/downloads', { method: 'PATCH', body: patch })
    await refresh()
    justAdded.value = creating
    adding.value = false
    saved.value = true
  }
  catch (err) {
    saveError.value = extractError(err, 'Could not save the downloads settings.')
  }
  finally {
    saving.value = false
  }
}

function revert() {
  seed(downloads.value ?? null)
  saveError.value = null
  saved.value = false
  // Reverting a block that was never saved means backing out of adding it entirely.
  if (!downloads.value)
    adding.value = false
}

// The two collapsed groups. `custom` counts the keys in a group that carry a value
// other than jack's default, so a collapsed group still says whether it holds
// anything you set yourself.
const transferKeys = ['maxDownloadAttempts', 'idleTimeoutMs', 'retryBaseDelayMs', 'retryMaxDelayMs'] as const
const importKeys = ['importPollIntervalMs', 'maxManualImportAttempts', 'manualImportBackoffBaseMs', 'manualImportBackoffMaxMs'] as const

const DEFAULTS: Record<string, number> = {
  maxConcurrentDownloads: 3,
  maxDownloadAttempts: 13,
  retryBaseDelayMs: 1000,
  retryMaxDelayMs: 1_800_000,
  idleTimeoutMs: 60_000,
  importPollIntervalMs: 30_000,
  maxManualImportAttempts: 6,
  manualImportBackoffBaseMs: 60_000,
  manualImportBackoffMaxMs: 1_800_000,
}

function customCount(keys: readonly string[]) {
  return keys.filter((key) => {
    const value = (state as Record<string, unknown>)[key]
    return typeof value === 'number' && value !== DEFAULTS[key]
  }).length
}

const transferOpen = ref(false)
const importOpen = ref(false)
</script>

<template>
  <SettingsSection
    title="Downloads"
    description="Where jack puts the files it pulls from peers, and how hard it tries."
  >
    <UAlert v-if="loadError" color="error" variant="soft" icon="i-ph-warning" title="Failed to load the downloads settings." />

    <p v-else-if="pending && !downloads" class="flex items-center gap-2 text-sm text-muted">
      <UIcon name="i-ph-circle-notch" class="size-4 animate-spin" />
      Loading…
    </p>

    <UCard v-else-if="!downloads && !adding" variant="subtle">
      <div class="flex flex-col items-center gap-3 py-6 text-center">
        <UIcon name="i-ph-download-simple" class="size-8 text-dimmed" />
        <p class="max-w-md text-sm text-muted">
          This instance shares its library but doesn't download from peers. Add a completed folder
          to start pulling from them.
        </p>
        <UButton label="Set up downloads" icon="i-ph-plus" @click="() => { adding = true }" />
      </div>
    </UCard>

    <UForm v-else :state="state" :validate="validate" class="space-y-3" @submit="save">
      <!-- The two settings you actually choose, kept above the fold. -->
      <UCard variant="subtle" :ui="{ body: 'space-y-4' }">
        <UFormField
          name="completedPath"
          label="Completed folder"
          description="Where jack writes finished downloads. Mount it into Radarr/Sonarr at this same path so they can import from it."
          required
        >
          <UInput v-model="state.completedPath" placeholder="/data/torrents/completed" class="w-full font-mono" />
        </UFormField>

        <ConfigNumberField
          v-model="state.maxConcurrentDownloads"
          name="maxConcurrentDownloads"
          label="Simultaneous transfers"
          description="How many peer downloads run at once."
          :default-value="DEFAULTS.maxConcurrentDownloads!"
          :min="1"
        />

        <USeparator />

        <UFormField
          name="unlinkImportedFiles"
          label="Unlink imported files"
          description="Once Radarr/Sonarr confirms it imported a download, remove jack's copy from the completed folder. If your *arr hardlinks, the library keeps the file and only jack's extra link goes away; if it copies, the copy is untouched. Only ever runs on a confirmed import — never on a queued or failed one."
        >
          <USwitch v-model="state.unlinkImportedFiles" />
        </UFormField>
      </UCard>

      <!-- Everything below is retry/backoff tuning: collapsed, because the defaults
           are right until something in your setup proves otherwise. -->
      <UCollapsible v-model:open="transferOpen">
        <UButton
          color="neutral"
          variant="subtle"
          block
          :ui="{ label: 'flex-1 text-left' }"
          label="Transfer retries"
          :icon="transferOpen ? 'i-ph-caret-down' : 'i-ph-caret-right'"
        >
          <template #trailing>
            <span v-if="customCount(transferKeys)" class="text-xs text-muted">{{ customCount(transferKeys) }} custom</span>
          </template>
        </UButton>

        <template #content>
          <UCard variant="subtle" class="mt-2" :ui="{ body: 'space-y-4' }">
            <p class="text-xs text-muted">
              How a stalled or failing transfer from a peer is retried.
            </p>
            <ConfigNumberField
              v-model="state.maxDownloadAttempts"
              name="maxDownloadAttempts"
              label="Attempts before giving up"
              description="How many times a failing download is retried before it's marked failed."
              :default-value="DEFAULTS.maxDownloadAttempts!"
              :min="1"
            />
            <ConfigNumberField
              v-model="state.idleTimeoutMs"
              name="idleTimeoutMs"
              label="Stall timeout"
              description="How long a transfer may receive no data before jack treats it as stalled and retries."
              :default-value="DEFAULTS.idleTimeoutMs!"
              unit="ms"
              :min="1000"
            />
            <ConfigNumberField
              v-model="state.retryBaseDelayMs"
              name="retryBaseDelayMs"
              label="First retry delay"
              description="Starting point for the backoff between retries. Each further attempt waits longer."
              :default-value="DEFAULTS.retryBaseDelayMs!"
              unit="ms"
            />
            <ConfigNumberField
              v-model="state.retryMaxDelayMs"
              name="retryMaxDelayMs"
              label="Longest retry delay"
              description="Ceiling for that backoff."
              :default-value="DEFAULTS.retryMaxDelayMs!"
              unit="ms"
            />
          </UCard>
        </template>
      </UCollapsible>

      <UCollapsible v-model:open="importOpen">
        <UButton
          color="neutral"
          variant="subtle"
          block
          :ui="{ label: 'flex-1 text-left' }"
          label="Handing files to *arr"
          :icon="importOpen ? 'i-ph-caret-down' : 'i-ph-caret-right'"
        >
          <template #trailing>
            <span v-if="customCount(importKeys)" class="text-xs text-muted">{{ customCount(importKeys) }} custom</span>
          </template>
        </UButton>

        <template #content>
          <UCard variant="subtle" class="mt-2" :ui="{ body: 'space-y-4' }">
            <p class="text-xs text-muted">
              jack watches each destination *arr to find out when a finished download was imported, and
              pushes an import itself for grabs your *arr won't pick up on its own.
            </p>
            <ConfigNumberField
              v-model="state.importPollIntervalMs"
              name="importPollIntervalMs"
              label="Import check interval"
              description="How often jack reads each *arr's import history."
              :default-value="DEFAULTS.importPollIntervalMs!"
              unit="ms"
              :min="1000"
            />
            <ConfigNumberField
              v-model="state.maxManualImportAttempts"
              name="maxManualImportAttempts"
              label="Import attempts before giving up"
              description="How many times jack pushes an import that *arr keeps rejecting before marking the download failed."
              :default-value="DEFAULTS.maxManualImportAttempts!"
              :min="1"
            />
            <ConfigNumberField
              v-model="state.manualImportBackoffBaseMs"
              name="manualImportBackoffBaseMs"
              label="First import retry delay"
              description="Starting point for the backoff between those attempts."
              :default-value="DEFAULTS.manualImportBackoffBaseMs!"
              unit="ms"
            />
            <ConfigNumberField
              v-model="state.manualImportBackoffMaxMs"
              name="manualImportBackoffMaxMs"
              label="Longest import retry delay"
              description="Ceiling for that backoff."
              :default-value="DEFAULTS.manualImportBackoffMaxMs!"
              unit="ms"
            />
          </UCard>
        </template>
      </UCollapsible>

      <UAlert v-if="saveError" color="error" variant="soft" icon="i-ph-warning" :title="saveError" />

      <UAlert
        v-else-if="saved"
        color="success"
        variant="soft"
        icon="i-ph-check-circle"
        title="Saved."
        :description="justAdded
          ? 'Restart the server to start downloading from peers with these settings.'
          : 'Unlinking applies right away. The other settings are read at startup, so restart the server for them to take effect.'"
      />

      <div class="flex flex-wrap items-center justify-end gap-2 pt-1">
        <p class="mr-auto text-xs text-muted">
          Clear a field to use jack's default.
        </p>
        <UButton v-if="dirty" label="Revert" color="neutral" variant="ghost" @click="revert" />
        <UButton type="submit" :disabled="!dirty" :loading="saving" :label="saving ? 'Saving…' : 'Save changes'" />
      </div>
    </UForm>
  </SettingsSection>
</template>
