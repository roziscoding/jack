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

const modeItems = [
  { label: 'Value', value: 'literal' },
  { label: 'Env var', value: 'env' },
  { label: 'File', value: 'file' },
]

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
    <USelect v-model="mode" :items="modeItems" class="w-28 shrink-0" />
    <UInput
      v-model="value"
      :type="inputType"
      :placeholder="placeholder"
      autocomplete="off"
      class="flex-1"
    >
      <template v-if="mode === 'literal'" #trailing>
        <UButton
          color="neutral"
          variant="link"
          size="sm"
          :icon="reveal ? 'i-ph-eye-slash' : 'i-ph-eye'"
          :aria-label="reveal ? 'Hide value' : 'Show value'"
          @click="reveal = !reveal"
        />
      </template>
    </UInput>
  </div>
</template>
