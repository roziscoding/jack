<script setup lang="ts">
import type { FormError } from '@nuxt/ui'
import type { JackConfig, SecretRef } from '~/types/management'

const props = defineProps<{
  initial?: JackConfig | null
  submitting?: boolean
  error?: string | null
}>()
const emit = defineEmits<{ submit: [JackConfig] }>()

const editing = computed(() => Boolean(props.initial))

const state = reactive({
  internalUrl: props.initial?.internalUrl ?? '',
  apiKey: (props.initial?.apiKey ?? null) as SecretRef | null,
  tmdbApiKey: (props.initial?.tmdbApiKey ?? null) as SecretRef | null,
})

// internalUrl is the only required field; the Main API key is optional/clearable.
function validate(s: typeof state): FormError[] {
  if (!s.internalUrl.trim())
    return [{ name: 'internalUrl', message: 'Enter the internal URL.' }]
  return []
}

function onSubmit() {
  const input: JackConfig = { internalUrl: state.internalUrl.trim() }
  // SecretInput emits null when cleared → omit apiKey entirely (optional).
  if (state.apiKey)
    input.apiKey = state.apiKey
  if (state.tmdbApiKey)
    input.tmdbApiKey = state.tmdbApiKey
  emit('submit', input)
}
</script>

<template>
  <UForm :state="state" :validate="validate" class="space-y-4" @submit="onSubmit">
    <UFormField
      name="internalUrl"
      label="Internal URL"
      description="The URL your *arr apps (Radarr/Sonarr) use to reach this Jack instance. Changes apply after the server restarts."
      required
    >
      <UInput v-model="state.internalUrl" placeholder="http://jack:5225" class="w-full" />
    </UFormField>

    <UFormField name="apiKey" label="Main API key" hint="Optional">
      <SecretInput v-model="state.apiKey" :editing="editing" />
      <template #help>
        <span class="text-warning">Deprecated — this single key will stop working soon. Use the API keys below instead.</span>
      </template>
    </UFormField>

    <UFormField name="tmdbApiKey" label="TMDB API key" hint="Optional">
      <SecretInput v-model="state.tmdbApiKey" :editing="editing" />
      <template #help>
        <span>Enables artwork and metadata when browsing peer catalogs. Applies after a restart.</span>
      </template>
    </UFormField>

    <UAlert v-if="error" color="error" variant="soft" icon="i-ph-warning" :title="error" />

    <div class="flex justify-end pt-2">
      <UButton type="submit" :loading="submitting" :label="submitting ? 'Saving…' : 'Save'" />
    </div>
  </UForm>
</template>
