<script setup lang="ts">
import type { FormError } from '@nuxt/ui'
import type { SecretRef, ServerInput, ServerItem } from '~/types/management'

const props = defineProps<{
  initial?: ServerItem | null
  submitting?: boolean
  error?: string | null
}>()
const emit = defineEmits<{ submit: [ServerInput], cancel: [] }>()

const editing = computed(() => Boolean(props.initial))

const typeItems = [
  { label: 'Radarr', value: 'radarr' },
  { label: 'Sonarr', value: 'sonarr' },
]

const state = reactive({
  name: props.initial?.name ?? '',
  url: props.initial?.url ?? '',
  type: (props.initial?.type as 'radarr' | 'sonarr') ?? 'radarr',
  apiKey: (props.initial?.apiKey ?? null) as SecretRef | null,
  source: props.initial?.source ?? true,
  destination: props.initial?.destination ?? true,
  autoEnable: props.initial?.autoregister?.enable ?? true,
  autoPriority: props.initial?.autoregister?.priority ?? 1,
  headers: { ...(props.initial?.headers ?? {}) } as Record<string, SecretRef>,
})

function validate(s: typeof state): FormError[] {
  const errors: FormError[] = []
  if (!s.name.trim())
    errors.push({ name: 'name', message: 'Give the server a name.' })
  if (!s.url.trim())
    errors.push({ name: 'url', message: 'Enter the server URL.' })
  if (!s.apiKey)
    errors.push({ name: 'apiKey', message: 'An API key is required.' })
  return errors
}

function onSubmit() {
  const input: ServerInput = {
    name: state.name.trim(),
    url: state.url.trim(),
    type: state.type,
    apiKey: state.apiKey!,
    source: state.source,
    destination: state.destination,
    autoregister: { enable: state.autoEnable, priority: state.autoPriority },
  }
  if (Object.keys(state.headers).length)
    input.headers = state.headers
  emit('submit', input)
}
</script>

<template>
  <UForm :state="state" :validate="validate" class="space-y-4" @submit="onSubmit">
    <UFormField name="name" label="Name" required>
      <UInput v-model="state.name" placeholder="Radarr" class="w-full" />
    </UFormField>

    <div class="flex gap-3">
      <UFormField name="url" label="URL" required class="flex-1">
        <UInput v-model="state.url" placeholder="http://radarr:7878" class="w-full" />
      </UFormField>
      <UFormField name="type" label="Type">
        <USelect v-model="state.type" :items="typeItems" class="w-32" />
      </UFormField>
    </div>

    <UFormField name="apiKey" label="API key" description="*arr API keys are 32-character hex." required>
      <SecretInput v-model="state.apiKey" :editing="editing" />
    </UFormField>

    <div class="flex gap-6">
      <UFormField name="source">
        <UCheckbox v-model="state.source" label="Source" />
      </UFormField>
      <UFormField name="destination">
        <UCheckbox v-model="state.destination" label="Destination" />
      </UFormField>
    </div>

    <UCard variant="subtle" :ui="{ body: 'space-y-3' }">
      <UCheckbox v-model="state.autoEnable" label="Auto-register jack in this *arr" />
      <UFormField v-if="state.autoEnable" label="Priority" :ui="{ container: 'w-24' }">
        <UInputNumber v-model="state.autoPriority" :min="1" />
      </UFormField>
    </UCard>

    <UFormField label="Headers" hint="Optional">
      <HeadersEditor v-model="state.headers" />
    </UFormField>

    <UAlert v-if="error" color="error" variant="soft" icon="i-ph-warning" :title="error" />

    <div class="flex justify-end gap-2 pt-2">
      <UButton label="Cancel" color="neutral" variant="ghost" @click="emit('cancel')" />
      <UButton type="submit" :loading="submitting" :label="submitting ? 'Saving…' : editing ? 'Save changes' : 'Add server'" />
    </div>
  </UForm>
</template>
