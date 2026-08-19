<script setup lang="ts">
import type { FormError } from '@nuxt/ui'
import type { ExternalJackConfig, SecretRef } from '~/types/management'

const props = defineProps<{
  available: boolean
  initial?: ExternalJackConfig | null
  submitting?: boolean
  error?: string | null
  saved?: boolean
}>()
const emit = defineEmits<{
  submit: [ExternalJackConfig]
  generate: []
  import: []
  remove: []
}>()

const state = reactive({
  instanceName: props.initial?.instanceName ?? '',
  url: props.initial?.url ?? '',
  headers: { ...(props.initial?.headers ?? {}) } as Record<string, SecretRef>,
})

function validate(s: typeof state): FormError[] {
  const errors: FormError[] = []
  if (!s.instanceName.trim())
    errors.push({ name: 'instanceName', message: 'Enter the instance name shared with peers.' })
  if (!s.url.trim()) {
    errors.push({ name: 'url', message: 'Enter the external URL.' })
  }
  else {
    try {
      const url = new URL(s.url)
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
        errors.push({ name: 'url', message: 'Use an HTTP or HTTPS URL without embedded credentials.' })
    }
    catch {
      errors.push({ name: 'url', message: 'Enter a valid external URL.' })
    }
  }
  return errors
}

function onSubmit() {
  emit('submit', {
    instanceName: state.instanceName.trim(),
    url: state.url.trim(),
    ...(Object.keys(state.headers).length ? { headers: state.headers } : {}),
  })
}
</script>

<template>
  <SettingsSection
    title="Quick linking"
    description="Configure how this Jack is shared, generate access links, or add a peer from one."
  >
    <template #aside>
      <div class="flex flex-wrap gap-2">
        <UButton
          label="Generate quick link"
          icon="i-ph-link"
          :disabled="!available || !initial?.url || !initial?.instanceName"
          :title="initial?.url && initial?.instanceName ? 'Generate a credential-bearing quick link' : 'Save the quick-linking configuration first'"
          @click="emit('generate')"
        />
        <UButton
          label="Add via quick link"
          color="neutral"
          variant="outline"
          icon="i-ph-link-simple"
          @click="emit('import')"
        />
      </div>
    </template>

    <UCard v-if="!available" variant="subtle">
      <UAlert
        color="neutral"
        variant="soft"
        icon="i-ph-info"
        title="Configure Jack first"
        description="You can still add a peer from a quick link, but generating links requires a local Jack configuration."
      />
    </UCard>

    <UCard v-else variant="subtle" :ui="{ body: 'space-y-4' }">
      <UForm :state="state" :validate="validate" class="space-y-4" @submit="onSubmit">
        <UFormField
          name="instanceName"
          label="Instance name"
          description="Suggested peer name shown to people who import one of this instance’s quick links."
          required
        >
          <UInput v-model="state.instanceName" placeholder="Roz’s Jack" :maxlength="100" class="w-full" />
        </UFormField>

        <UFormField
          name="url"
          label="External URL"
          description="The URL another Jack should use to reach this instance."
          required
        >
          <UInput v-model="state.url" placeholder="https://jack.example.com" class="w-full" />
        </UFormField>

        <UFormField label="External headers" hint="Optional">
          <HeadersEditor v-model="state.headers" />
          <template #help>
            <span>Proxy credentials such as Cloudflare Access headers. Prefer environment or file refs over literal values.</span>
          </template>
        </UFormField>

        <UAlert v-if="error" color="error" variant="soft" icon="i-ph-warning" :title="error" />
        <UAlert v-if="saved" color="success" variant="soft" icon="i-ph-check-circle" title="Quick-linking configuration saved." />

        <div class="flex justify-between gap-2 pt-2">
          <UButton
            v-if="initial"
            type="button"
            label="Remove configuration"
            color="error"
            variant="ghost"
            :disabled="submitting"
            @click="emit('remove')"
          />
          <UButton type="submit" :loading="submitting" :label="submitting ? 'Saving…' : 'Save'" />
        </div>
      </UForm>
    </UCard>
  </SettingsSection>
</template>
