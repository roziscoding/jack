<script setup lang="ts">
import type { SecretRef } from '~/types/management'

const props = defineProps<{
  modelValue: SecretRef | null
  // GET /config returns refs intact, so an edit form prefills this with the stored
  // value/ref. `editing` only tweaks the empty-field placeholder (shown if the user
  // clears it) to read "replace" rather than "set".
  editing?: boolean
}>()
const emit = defineEmits<{ 'update:modelValue': [SecretRef | null] }>()

type Mode = 'literal' | 'env' | 'file'

function detectMode(v: SecretRef | null): Mode {
  if (v && typeof v === 'object')
    return 'env' in v ? 'env' : 'file'
  return 'literal'
}
function detectValue(v: SecretRef | null): string {
  if (typeof v === 'string')
    return v
  if (v && 'env' in v)
    return v.env
  if (v && 'file' in v)
    return v.file
  return ''
}

const mode = ref<Mode>(detectMode(props.modelValue))
const value = ref(detectValue(props.modelValue))
// Literal secrets are masked by default; the user opts into revealing the stored
// plaintext. Env/file refs aren't secret (just a name/path) so they always show.
const reveal = ref(false)
const inputType = computed(() => (mode.value === 'literal' && !reveal.value ? 'password' : 'text'))

const placeholder = computed(() => {
  if (mode.value === 'env')
    return 'ENV_VAR_NAME'
  if (mode.value === 'file')
    return '/run/secrets/key'
  return props.editing ? 'Re-enter to replace stored value' : 'plain secret value'
})

watch([mode, value], () => {
  const v = value.value.trim()
  if (!v) {
    emit('update:modelValue', null)
    return
  }
  if (mode.value === 'env')
    emit('update:modelValue', { env: v })
  else if (mode.value === 'file')
    emit('update:modelValue', { file: v })
  else
    emit('update:modelValue', v)
})
</script>

<template>
  <div class="flex gap-2">
    <select
      v-model="mode"
      class="rounded-lg border border-slate-700 bg-slate-950 px-2 py-2 text-sm outline-none focus:border-brand-500"
    >
      <option value="literal">
        Value
      </option>
      <option value="env">
        Env var
      </option>
      <option value="file">
        File
      </option>
    </select>
    <input
      v-model="value"
      :type="inputType"
      :placeholder="placeholder"
      autocomplete="off"
      class="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm outline-none focus:border-brand-500"
    >
    <label v-if="mode === 'literal'" class="flex items-center gap-1 whitespace-nowrap text-xs text-slate-400">
      <input v-model="reveal" type="checkbox" class="rounded border-slate-700 bg-slate-950"> Show
    </label>
  </div>
</template>
