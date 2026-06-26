<script setup lang="ts">
import type { JackConfig, SecretRef } from '~/types/management'

const props = defineProps<{
  initial?: JackConfig | null
  submitting?: boolean
  error?: string | null
}>()
const emit = defineEmits<{ submit: [JackConfig] }>()

const editing = computed(() => Boolean(props.initial))
const internalUrl = ref(props.initial?.internalUrl ?? '')
const apiKey = ref<SecretRef | null>(props.initial?.apiKey ?? null)

// internalUrl is the only required field; the Main API key is optional/clearable.
const valid = computed(() => Boolean(internalUrl.value.trim()))

function submit() {
  if (!valid.value)
    return
  const input: JackConfig = { internalUrl: internalUrl.value.trim() }
  // SecretInput emits null when cleared → omit apiKey entirely (optional).
  if (apiKey.value)
    input.apiKey = apiKey.value
  emit('submit', input)
}
</script>

<template>
  <form class="space-y-4" @submit.prevent="submit">
    <div>
      <label class="mb-1 block text-sm text-slate-300">Internal URL</label>
      <input
        v-model="internalUrl"
        placeholder="http://jack:5225"
        class="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm outline-none focus:border-brand-500"
      >
      <p class="mt-1 text-xs text-slate-500">
        The URL your *arr apps (Radarr/Sonarr) use to reach this Jack instance. Changes apply after the server restarts.
      </p>
    </div>
    <div>
      <label class="mb-1 block text-sm text-slate-300">
        Main API key <span class="text-slate-600">(optional)</span>
      </label>
      <SecretInput v-model="apiKey" :editing="editing" />
      <p class="mt-1 text-xs text-amber-400/80">
        Deprecated — this single key will stop working soon. Use the API keys below instead.
      </p>
    </div>

    <FormAlert v-if="error" :message="error" />

    <div class="flex justify-end pt-2">
      <button
        type="submit"
        :disabled="!valid || submitting"
        class="rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-brand-500 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {{ submitting ? 'Saving…' : 'Save' }}
      </button>
    </div>
  </form>
</template>
