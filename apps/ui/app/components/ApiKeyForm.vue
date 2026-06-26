<script setup lang="ts">
import type { FormError } from '@nuxt/ui'
import type { ApiKey, ApiKeyInput } from '~/types/management'

const props = defineProps<{
  initial?: ApiKey | null
  submitting?: boolean
  error?: string | null
}>()
const emit = defineEmits<{ submit: [ApiKeyInput], cancel: [] }>()

const editing = computed(() => Boolean(props.initial))

type Preset = 'never' | '30d' | '90d' | '1y' | 'custom'
const PRESET_DAYS: Record<'30d' | '90d' | '1y', number> = { '30d': 30, '90d': 90, '1y': 365 }

const presetItems = [
  { label: 'Never expires', value: 'never' },
  { label: 'In 30 days', value: '30d' },
  { label: 'In 90 days', value: '90d' },
  { label: 'In 1 year', value: '1y' },
  { label: 'Custom date…', value: 'custom' },
]

const state = reactive({
  name: props.initial?.name ?? '',
  description: props.initial?.description ?? '',
  // An existing key already carries an absolute instant, so editing always lands in
  // "custom" with that date prefilled; new keys default to never-expiring.
  preset: (props.initial?.expiresAt ? 'custom' : 'never') as Preset,
  customAt: props.initial?.expiresAt ? toDatetimeLocal(props.initial.expiresAt) : '',
})

// datetime-local wants local wall-clock `YYYY-MM-DDTHH:mm`, not an ISO instant.
function toDatetimeLocal(iso: string): string {
  const d = new Date(iso)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

const nowLocal = computed(() => toDatetimeLocal(new Date().toISOString()))

// The UI owns the "must be in the future" guard — the backend validates ISO shape
// only, so a past date would save and then reject on every use.
function validate(s: typeof state): FormError[] {
  if (s.preset !== 'custom')
    return []
  if (!s.customAt)
    return [{ name: 'customAt', message: 'Pick an expiration date.' }]
  const t = new Date(s.customAt).getTime()
  if (Number.isNaN(t) || t <= Date.now())
    return [{ name: 'customAt', message: 'Pick a date in the future.' }]
  return []
}

function resolveExpiresAt(): string | null {
  if (state.preset === 'never')
    return null
  if (state.preset === 'custom')
    return new Date(state.customAt).toISOString()
  return new Date(Date.now() + PRESET_DAYS[state.preset] * 86_400_000).toISOString()
}

function onSubmit() {
  emit('submit', {
    name: state.name.trim() || null,
    description: state.description.trim() || null,
    expiresAt: resolveExpiresAt(),
  })
}
</script>

<template>
  <UForm :state="state" :validate="validate" class="space-y-4" @submit="onSubmit">
    <UFormField
      name="name"
      label="Name"
      hint="Optional"
      description="Name it so you can recognize it later — the key itself is only shown once."
    >
      <UInput v-model="state.name" :maxlength="100" placeholder="Radarr on the NAS" class="w-full" />
    </UFormField>

    <UFormField name="description" label="Description" hint="Optional">
      <UTextarea v-model="state.description" :maxlength="500" :rows="2" placeholder="What this key is used for" class="w-full" />
    </UFormField>

    <UFormField name="preset" label="Expiration">
      <USelect v-model="state.preset" :items="presetItems" class="w-full" />
    </UFormField>

    <UFormField v-if="state.preset === 'custom'" name="customAt" label="Expires at">
      <UInput v-model="state.customAt" type="datetime-local" :min="nowLocal" class="w-full" />
    </UFormField>

    <UAlert v-if="error" color="error" variant="soft" icon="i-ph-warning" :title="error" />

    <div class="flex justify-end gap-2 pt-2">
      <UButton label="Cancel" color="neutral" variant="ghost" @click="emit('cancel')" />
      <UButton type="submit" :loading="submitting" :label="submitting ? 'Saving…' : editing ? 'Save' : 'Create key'" />
    </div>
  </UForm>
</template>
