<script setup lang="ts">
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

const name = ref(props.initial?.name ?? '')
const description = ref(props.initial?.description ?? '')
// An existing key already carries an absolute instant, so editing always lands in
// "custom" with that date prefilled; new keys default to never-expiring.
const preset = ref<Preset>(props.initial?.expiresAt ? 'custom' : 'never')
const customAt = ref(props.initial?.expiresAt ? toDatetimeLocal(props.initial.expiresAt) : '')

// datetime-local wants local wall-clock `YYYY-MM-DDTHH:mm`, not an ISO instant.
function toDatetimeLocal(iso: string): string {
  const d = new Date(iso)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

const nowLocal = computed(() => toDatetimeLocal(new Date().toISOString()))

// The UI owns the "must be in the future" guard — the backend validates ISO shape
// only, so a past date would save and then reject on every use.
const customInFuture = computed(() => {
  if (preset.value !== 'custom')
    return true
  const t = new Date(customAt.value).getTime()
  return !Number.isNaN(t) && t > Date.now()
})
const valid = computed(() => preset.value !== 'custom' || (Boolean(customAt.value) && customInFuture.value))

function resolveExpiresAt(): string | null {
  if (preset.value === 'never')
    return null
  if (preset.value === 'custom')
    return new Date(customAt.value).toISOString()
  return new Date(Date.now() + PRESET_DAYS[preset.value] * 86_400_000).toISOString()
}

function submit() {
  if (!valid.value)
    return
  emit('submit', {
    name: name.value.trim() || null,
    description: description.value.trim() || null,
    expiresAt: resolveExpiresAt(),
  })
}
</script>

<template>
  <form class="space-y-4" @submit.prevent="submit">
    <div>
      <label class="mb-1 block text-sm text-slate-300">Name <span class="text-slate-600">(optional)</span></label>
      <input
        v-model="name"
        maxlength="100"
        placeholder="Radarr on the NAS"
        class="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm outline-none focus:border-brand-500"
      >
      <p class="mt-1 text-xs text-slate-600">
        Name it so you can recognize it later — the key itself is only shown once.
      </p>
    </div>

    <div>
      <label class="mb-1 block text-sm text-slate-300">Description <span class="text-slate-600">(optional)</span></label>
      <textarea
        v-model="description"
        maxlength="500"
        rows="2"
        placeholder="What this key is used for"
        class="w-full resize-none rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm outline-none focus:border-brand-500"
      />
    </div>

    <div>
      <label class="mb-1 block text-sm text-slate-300">Expiration</label>
      <select
        v-model="preset"
        class="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm outline-none focus:border-brand-500"
      >
        <option value="never">
          Never expires
        </option>
        <option value="30d">
          In 30 days
        </option>
        <option value="90d">
          In 90 days
        </option>
        <option value="1y">
          In 1 year
        </option>
        <option value="custom">
          Custom date…
        </option>
      </select>
      <div v-if="preset === 'custom'" class="mt-2">
        <input
          v-model="customAt"
          type="datetime-local"
          :min="nowLocal"
          class="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm outline-none focus:border-brand-500"
        >
        <p v-if="customAt && !customInFuture" class="mt-1 text-xs text-rose-300">
          Pick a date in the future.
        </p>
      </div>
    </div>

    <FormAlert v-if="error" :message="error" />

    <div class="flex justify-end gap-2 pt-2">
      <button type="button" class="rounded-lg px-4 py-2 text-sm text-slate-400 hover:text-slate-100" @click="emit('cancel')">
        Cancel
      </button>
      <button
        type="submit"
        :disabled="!valid || submitting"
        class="rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-brand-500 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {{ submitting ? 'Saving…' : editing ? 'Save' : 'Create key' }}
      </button>
    </div>
  </form>
</template>
