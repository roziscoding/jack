<script setup lang="ts">
import type { DownloadsConfig } from '~/types/management'

const { request, extractError } = useManagement()

// `null` is a real answer here: no downloads block in the config file, i.e. this
// instance only shares its library and never pulls — there is nothing to clean up.
// Lazy so this section never blocks the rest of Settings from rendering; the
// template covers the loading and failed states itself.
const { data: downloads, pending, error: loadError, refresh } = useLazyAsyncData(
  'downloads-config',
  () => request<DownloadsConfig | null>('config/downloads'),
)

const saving = ref(false)
const saveError = ref<string | null>(null)

const unlinkImportedFiles = computed({
  get: () => downloads.value?.unlinkImportedFiles ?? false,
  set: value => void save(value),
})

// A partial PATCH: the backend merges it into the stored block, so the other
// downloads knobs (which live in the config file only) are never touched.
async function save(unlink: boolean) {
  saving.value = true
  saveError.value = null
  try {
    await request('config/downloads', { method: 'PATCH', body: { unlinkImportedFiles: unlink } })
    await refresh()
  }
  catch (err) {
    saveError.value = extractError(err, 'Could not save the downloads config.')
    // Put the switch back where the server still has it.
    await refresh()
  }
  finally {
    saving.value = false
  }
}
</script>

<template>
  <SettingsSection
    title="Downloads"
    description="What jack does with the files it pulls from peers."
  >
    <UAlert v-if="loadError" color="error" variant="soft" icon="i-ph-warning" title="Failed to load the downloads config." />

    <p v-else-if="pending && !downloads" class="flex items-center gap-2 text-sm text-muted">
      <UIcon name="i-ph-circle-notch" class="size-4 animate-spin" />
      Loading…
    </p>

    <UCard v-else-if="!downloads" variant="subtle">
      <div class="flex flex-col items-center gap-3 py-6 text-center">
        <UIcon name="i-ph-download-simple" class="size-8 text-dimmed" />
        <p class="text-sm text-muted">
          No <code class="font-mono text-xs">downloads</code> block in the config file — this instance
          doesn't download from peers, so there's nothing to configure here.
        </p>
      </div>
    </UCard>

    <UCard v-else variant="subtle" :ui="{ body: 'space-y-4' }">
      <UFormField
        name="unlinkImportedFiles"
        label="Unlink imported files"
        description="Once Radarr/Sonarr confirms it imported a download, remove jack's copy from the completed folder. If your *arr hardlinks, the library keeps the file and only jack's extra link goes away; if it copies, the copy is untouched. Only ever runs on a confirmed import — never on a queued or failed one."
      >
        <div class="flex items-center gap-3">
          <USwitch v-model="unlinkImportedFiles" :disabled="saving" />
          <UIcon v-if="saving" name="i-ph-circle-notch" class="size-4 animate-spin text-muted" />
        </div>
      </UFormField>

      <p class="text-xs text-muted">
        Applies immediately — no restart needed. The remaining download settings
        (<code class="font-mono">completedPath</code>, retry and import tuning) live in the config file.
      </p>

      <UAlert v-if="saveError" color="error" variant="soft" icon="i-ph-warning" :title="saveError" />
    </UCard>
  </SettingsSection>
</template>
