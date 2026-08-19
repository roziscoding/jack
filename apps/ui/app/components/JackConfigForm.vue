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
  externalInstanceName: props.initial?.external?.instanceName ?? '',
  externalUrl: props.initial?.external?.url ?? '',
  externalHeaders: { ...(props.initial?.external?.headers ?? {}) } as Record<string, SecretRef>,
})

// internalUrl is the only required field; the Main API key is optional/clearable.
function validate(s: typeof state): FormError[] {
  const errors: FormError[] = []
  if (!s.internalUrl.trim())
    errors.push({ name: 'internalUrl', message: 'Enter the internal URL.' })
  if (!s.externalUrl.trim() && Object.keys(s.externalHeaders).length)
    errors.push({ name: 'externalUrl', message: 'Enter the external URL for these headers.' })
  if (!s.externalUrl.trim() && s.externalInstanceName.trim())
    errors.push({ name: 'externalUrl', message: 'Enter the external URL for this instance.' })
  if (s.externalUrl.trim()) {
    if (!s.externalInstanceName.trim())
      errors.push({ name: 'externalInstanceName', message: 'Enter the instance name shared with peers.' })
    try {
      const url = new URL(s.externalUrl)
      if (!['http:', 'https:'].includes(url.protocol))
        errors.push({ name: 'externalUrl', message: 'Use an HTTP or HTTPS URL.' })
    }
    catch {
      errors.push({ name: 'externalUrl', message: 'Enter a valid external URL.' })
    }
  }
  return errors
}

function onSubmit() {
  const input: JackConfig = { internalUrl: state.internalUrl.trim() }
  // SecretInput emits null when cleared → omit apiKey entirely (optional).
  if (state.apiKey)
    input.apiKey = state.apiKey
  if (state.tmdbApiKey)
    input.tmdbApiKey = state.tmdbApiKey
  if (state.externalUrl.trim()) {
    input.external = {
      instanceName: state.externalInstanceName.trim(),
      url: state.externalUrl.trim(),
      ...(Object.keys(state.externalHeaders).length ? { headers: state.externalHeaders } : {}),
    }
  }
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

    <USeparator label="External access" />

    <UFormField
      name="externalInstanceName"
      label="Instance name"
      hint="Optional until external access is configured"
      description="Suggested peer name shown to people who import one of this instance’s quick links."
    >
      <UInput v-model="state.externalInstanceName" placeholder="Roz’s Jack" :maxlength="100" class="w-full" />
    </UFormField>

    <UFormField
      name="externalUrl"
      label="External URL"
      hint="Optional"
      description="The URL another Jack should use to reach this instance. Required before generating a quick link."
    >
      <UInput v-model="state.externalUrl" placeholder="https://jack.example.com" class="w-full" />
    </UFormField>

    <UFormField label="External headers" hint="Optional">
      <HeadersEditor v-model="state.externalHeaders" />
      <template #help>
        <span>Proxy credentials such as Cloudflare Access headers. Prefer environment or file refs over literal values.</span>
      </template>
    </UFormField>

    <UAlert v-if="error" color="error" variant="soft" icon="i-ph-warning" :title="error" />

    <div class="flex justify-end pt-2">
      <UButton type="submit" :loading="submitting" :label="submitting ? 'Saving…' : 'Save'" />
    </div>
  </UForm>
</template>
