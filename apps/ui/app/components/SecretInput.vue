<script setup lang="ts">
import type { SecretRef } from '~/types/management'

const props = defineProps<{
  modelValue: SecretRef | null
  // On edit we can't pre-fill a literal secret (the API never returns it), so the
  // field starts empty with a hint that re-entering replaces the stored value.
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
      :type="mode === 'literal' ? 'password' : 'text'"
      :placeholder="placeholder"
      autocomplete="off"
      class="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm outline-none focus:border-brand-500"
    >
  </div>
</template>
