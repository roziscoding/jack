<script setup lang="ts">
import type { PeerInput, PeerItem, SecretRef } from '~/types/management'

const props = defineProps<{
  initial?: PeerItem | null
  submitting?: boolean
  error?: string | null
}>()
const emit = defineEmits<{ submit: [PeerInput, boolean], cancel: [] }>()

const editing = computed(() => Boolean(props.initial))
const name = ref(props.initial?.name ?? '')
const url = ref(props.initial?.url ?? '')
const apiKey = ref<SecretRef | null>(props.initial?.apiKey ?? null)
const headers = ref<Record<string, SecretRef>>(props.initial?.headers ?? {})

const valid = computed(() => Boolean(name.value.trim() && url.value.trim() && apiKey.value))

// Set by a shift-click on the submit button (the click fires before the form's
// submit). Enter-to-submit leaves it false → a normal, connectivity-checked save.
const forceNext = ref(false)

function onForceModifier(e: MouseEvent) {
  forceNext.value = e.shiftKey
}

function submit() {
  if (!valid.value)
    return
  const input: PeerInput = { name: name.value.trim(), url: url.value.trim(), apiKey: apiKey.value! }
  if (Object.keys(headers.value).length)
    input.headers = headers.value
  emit('submit', input, forceNext.value)
  forceNext.value = false
}
</script>

<template>
  <form class="space-y-4" @submit.prevent="submit">
    <div>
      <label class="mb-1 block text-sm text-slate-300">Name</label>
      <input v-model="name" placeholder="Friend's Jack" class="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm outline-none focus:border-brand-500">
    </div>
    <div>
      <label class="mb-1 block text-sm text-slate-300">URL</label>
      <input v-model="url" placeholder="https://jack.friend.example" class="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm outline-none focus:border-brand-500">
    </div>
    <div>
      <label class="mb-1 block text-sm text-slate-300">API key</label>
      <SecretInput v-model="apiKey" :editing="editing" />
    </div>
    <div>
      <label class="mb-1 block text-sm text-slate-300">Headers <span class="text-slate-600">(optional)</span></label>
      <HeadersEditor v-model="headers" />
    </div>

    <FormAlert v-if="error" :message="error" />

    <div class="flex justify-end gap-2 pt-2">
      <button type="button" class="rounded-lg px-4 py-2 text-sm text-slate-400 hover:text-slate-100" @click="emit('cancel')">
        Cancel
      </button>
      <button
        type="submit"
        :disabled="!valid || submitting"
        title="Shift-click to save even if the peer can't be reached (it'll retry later)"
        class="rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-brand-500 disabled:cursor-not-allowed disabled:opacity-50"
        @click="onForceModifier"
      >
        {{ submitting ? 'Saving…' : 'Save' }}
      </button>
    </div>
  </form>
</template>
