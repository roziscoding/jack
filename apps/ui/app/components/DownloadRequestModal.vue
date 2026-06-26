<script setup lang="ts">
import type { CatalogRequestPayload, CatalogTitle, RequestServerOption } from '~/types/management'

const props = defineProps<{ open: boolean, title: CatalogTitle | null, submitting?: boolean, error?: string | null }>()
const emit = defineEmits<{ 'update:open': [boolean], 'confirm': [CatalogRequestPayload] }>()

// Codebase convention (see settings.vue) is a computed get/set bridge for v-model,
// not defineModel (which this app does not use).
const open = computed({ get: () => props.open, set: v => emit('update:open', v) })

const { request } = useManagement()
const { data, pending } = await useAsyncData('request-options', () =>
  request<{ servers: RequestServerOption[] }>('catalog/request-options'))

const candidates = computed(() =>
  (data.value?.servers ?? []).filter(s => props.title && s.mediaType === props.title.mediaType))

// USelect's v-model does not accept null; undefined behaves identically under the
// `!= null` / `== null` loose checks below, so we use undefined for "unset".
const serverId = ref<string | undefined>(undefined)
const qualityProfileId = ref<number | undefined>(undefined)
const rootFolderPath = ref<string | undefined>(undefined)

const server = computed(() => candidates.value.find(s => s.id === serverId.value) ?? null)

watch(candidates, (list) => {
  if (list.length && !list.some(s => s.id === serverId.value))
    serverId.value = list[0]!.id
}, { immediate: true })

watch(server, (s) => {
  qualityProfileId.value = s?.qualityProfiles[0]?.id ?? undefined
  rootFolderPath.value = s?.rootFolders[0]?.path ?? undefined
}, { immediate: true })

const canSubmit = computed(() => Boolean(serverId.value && qualityProfileId.value != null && rootFolderPath.value))

function onConfirm() {
  if (!canSubmit.value || !serverId.value || qualityProfileId.value == null || !rootFolderPath.value)
    return
  emit('confirm', { serverId: serverId.value, qualityProfileId: Number(qualityProfileId.value), rootFolderPath: rootFolderPath.value })
}
</script>

<template>
  <UModal v-model:open="open" title="Add to your library" :ui="{ footer: 'justify-end' }">
    <template #body>
      <p v-if="pending" class="flex items-center gap-2 text-sm text-muted">
        <UIcon name="i-ph-circle-notch" class="size-4 animate-spin" />
        Loading options…
      </p>

      <p v-else-if="candidates.length === 0" class="text-sm text-muted">
        No {{ title?.mediaType === 'tv' ? 'Sonarr' : 'Radarr' }} destination is configured for this type. Add one in Settings.
      </p>

      <div v-else class="space-y-4">
        <UFormField label="Send to">
          <USelect
            v-model="serverId"
            :items="candidates.map(s => ({ label: s.name, value: s.id }))"
            class="w-full"
          />
        </UFormField>

        <UFormField label="Quality profile">
          <USelect
            v-model="qualityProfileId"
            :items="(server?.qualityProfiles ?? []).map(p => ({ label: p.name, value: p.id }))"
            class="w-full"
          />
        </UFormField>

        <UFormField label="Root folder">
          <USelect
            v-model="rootFolderPath"
            :items="(server?.rootFolders ?? []).map(f => ({ label: f.path, value: f.path }))"
            class="w-full"
          />
        </UFormField>

        <UAlert v-if="error" color="error" variant="soft" icon="i-ph-warning" :title="error" />
      </div>
    </template>

    <template #footer="{ close }">
      <UButton label="Cancel" color="neutral" variant="ghost" @click="close" />
      <UButton
        label="Download"
        icon="i-ph-download-simple"
        :disabled="!canSubmit"
        :loading="submitting"
        @click="onConfirm"
      />
    </template>
  </UModal>
</template>
