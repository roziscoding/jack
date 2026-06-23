<script setup lang="ts">
import type { SecretRef, ServerInput, ServerItem } from '~/types/management'

const props = defineProps<{
  initial?: ServerItem | null
  submitting?: boolean
  error?: string | null
}>()
const emit = defineEmits<{ submit: [ServerInput], cancel: [] }>()

const editing = computed(() => Boolean(props.initial))
const name = ref(props.initial?.name ?? '')
const url = ref(props.initial?.url ?? '')
const type = ref<'radarr' | 'sonarr'>((props.initial?.type as 'radarr' | 'sonarr') ?? 'radarr')
const apiKey = ref<SecretRef | null>(props.initial?.apiKey ?? null)
const source = ref(props.initial?.source ?? true)
const destination = ref(props.initial?.destination ?? true)
const autoEnable = ref(props.initial?.autoregister?.enable ?? true)
const autoPriority = ref(props.initial?.autoregister?.priority ?? 1)
const headers = ref<Record<string, SecretRef>>(props.initial?.headers ?? {})

const valid = computed(() => Boolean(name.value.trim() && url.value.trim() && apiKey.value))

function submit() {
  if (!valid.value)
    return
  const input: ServerInput = {
    name: name.value.trim(),
    url: url.value.trim(),
    type: type.value,
    apiKey: apiKey.value!,
    source: source.value,
    destination: destination.value,
    autoregister: { enable: autoEnable.value, priority: autoPriority.value },
  }
  if (Object.keys(headers.value).length)
    input.headers = headers.value
  emit('submit', input)
}
</script>

<template>
  <form class="space-y-4" @submit.prevent="submit">
    <div>
      <label class="mb-1 block text-sm text-slate-300">Name</label>
      <input v-model="name" placeholder="Radarr" class="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm outline-none focus:border-brand-500">
    </div>
    <div class="flex gap-3">
      <div class="flex-1">
        <label class="mb-1 block text-sm text-slate-300">URL</label>
        <input v-model="url" placeholder="http://radarr:7878" class="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm outline-none focus:border-brand-500">
      </div>
      <div>
        <label class="mb-1 block text-sm text-slate-300">Type</label>
        <select v-model="type" class="rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm outline-none focus:border-brand-500">
          <option value="radarr">
            Radarr
          </option>
          <option value="sonarr">
            Sonarr
          </option>
        </select>
      </div>
    </div>
    <div>
      <label class="mb-1 block text-sm text-slate-300">API key</label>
      <SecretInput v-model="apiKey" :editing="editing" />
      <p class="mt-1 text-xs text-slate-500">
        *arr API keys are 32-character hex.
      </p>
    </div>

    <div class="flex gap-6">
      <label class="flex items-center gap-2 text-sm text-slate-300">
        <input v-model="source" type="checkbox" class="rounded border-slate-700 bg-slate-950"> Source
      </label>
      <label class="flex items-center gap-2 text-sm text-slate-300">
        <input v-model="destination" type="checkbox" class="rounded border-slate-700 bg-slate-950"> Destination
      </label>
    </div>

    <div class="rounded-lg border border-slate-800 p-3">
      <label class="flex items-center gap-2 text-sm text-slate-300">
        <input v-model="autoEnable" type="checkbox" class="rounded border-slate-700 bg-slate-950"> Auto-register jack in this *arr
      </label>
      <div v-if="autoEnable" class="mt-2 flex items-center gap-2">
        <label class="text-sm text-slate-400">Priority</label>
        <input v-model.number="autoPriority" type="number" min="1" class="w-20 rounded-lg border border-slate-700 bg-slate-950 px-2 py-1 text-sm outline-none focus:border-brand-500">
      </div>
    </div>

    <div>
      <label class="mb-1 block text-sm text-slate-300">Headers <span class="text-slate-600">(optional)</span></label>
      <HeadersEditor v-model="headers" />
    </div>

    <p v-if="error" class="text-sm text-rose-400">
      {{ error }}
    </p>

    <div class="flex justify-end gap-2 pt-2">
      <button type="button" class="rounded-lg px-4 py-2 text-sm text-slate-400 hover:text-slate-100" @click="emit('cancel')">
        Cancel
      </button>
      <button
        type="submit"
        :disabled="!valid || submitting"
        class="rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-brand-500 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {{ submitting ? 'Saving…' : editing ? 'Save changes' : 'Add server' }}
      </button>
    </div>
  </form>
</template>
