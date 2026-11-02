<script setup lang="ts">
import type { CatalogConfig } from '~/types/management'

const DEFAULT_SCHEDULE = '0 * * * *'
const PRESETS = [
  { label: 'Every hour', value: '0 * * * *' },
  { label: 'Every 6 hours', value: '0 */6 * * *' },
  { label: 'Every 12 hours', value: '0 */12 * * *' },
  { label: 'Once a day', value: '0 4 * * *' },
  { label: 'Custom schedule', value: 'custom' },
]

const { request, extractError } = useManagement()

const { data: catalog, pending, error: loadError, refresh } = useLazyAsyncData(
  'catalog-config',
  () => request<CatalogConfig | null>('config/catalog'),
)

const schedule = ref(DEFAULT_SCHEDULE)
const baseline = ref(DEFAULT_SCHEDULE)
// Picking "Custom schedule" keeps the current expression and shows it for editing,
// even when it still matches a preset.
const customizing = ref(false)

watch(() => catalog.value, (config) => {
  schedule.value = config?.refreshSchedule ?? DEFAULT_SCHEDULE
  baseline.value = schedule.value
  customizing.value = !PRESETS.some(p => p.value === schedule.value)
}, { immediate: true })

const preset = computed({
  get: () => customizing.value
    ? 'custom'
    : schedule.value,
  set: (value: string) => {
    customizing.value = value === 'custom'
    if (!customizing.value)
      schedule.value = value
  },
})

const dirty = computed(() => schedule.value.trim() !== baseline.value)

const saving = ref(false)
const saveError = ref<string | null>(null)
const saved = ref(false)
watch(dirty, (isDirty) => {
  if (isDirty)
    saved.value = false
})

async function save() {
  saving.value = true
  saveError.value = null
  saved.value = false
  const value = schedule.value.trim()
  try {
    // The default is written as an absent key, so a future default change applies.
    await request('config/catalog', {
      method: 'PATCH',
      body: {
        refreshSchedule: value === DEFAULT_SCHEDULE
          ? null
          : value,
      },
    })
    await refresh()
    saved.value = true
  }
  catch (err) {
    saveError.value = extractError(err, 'Could not save the catalog settings.')
  }
  finally {
    saving.value = false
  }
}

function revert() {
  schedule.value = baseline.value
  customizing.value = !PRESETS.some(p => p.value === baseline.value)
  saveError.value = null
}
</script>

<template>
  <SettingsSection
    title="Peer catalog"
    description="How often jack refreshes its own catalog and every peer's. The Peer Catalog page searches the result."
  >
    <UAlert v-if="loadError" color="error" variant="soft" icon="i-ph-warning" title="Failed to load the catalog settings." />

    <p v-else-if="pending && !catalog" class="flex items-center gap-2 text-sm text-muted">
      <UIcon name="i-ph-circle-notch" class="size-4 animate-spin" />
      Loading…
    </p>

    <UForm v-else :state="{ schedule }" class="space-y-3" @submit="save">
      <UCard variant="subtle" :ui="{ body: 'space-y-4' }">
        <UFormField
          name="preset"
          label="Refresh"
          description="Peers that are offline keep their last catalog until they answer again. You can also refresh right away from the Peer Catalog page."
        >
          <USelect v-model="preset" :items="PRESETS" :disabled="saving" class="w-full sm:w-56" />
        </UFormField>

        <UFormField
          v-if="customizing"
          name="schedule"
          label="Cron expression"
          description="Five fields: minute, hour, day of month, month, day of week, in the server's time zone. For example, 30 */2 * * * runs at half past every second hour."
        >
          <UInput v-model="schedule" :disabled="saving" placeholder="0 * * * *" class="w-full font-mono sm:w-56" />
        </UFormField>
      </UCard>

      <UAlert v-if="saveError" color="error" variant="soft" icon="i-ph-warning" :title="saveError" />
      <UAlert v-else-if="saved" color="success" variant="soft" icon="i-ph-check-circle" title="Saved. The new schedule applies right away." />

      <div class="flex flex-wrap items-center justify-end gap-2 pt-1">
        <UButton v-if="dirty" label="Revert" color="neutral" variant="ghost" :disabled="saving" @click="revert" />
        <UButton type="submit" :disabled="!dirty || !schedule.trim()" :loading="saving" :label="saving ? 'Saving…' : 'Save changes'" />
      </div>
    </UForm>
  </SettingsSection>
</template>
