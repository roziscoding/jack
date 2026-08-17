<script setup lang="ts">
import type { FormError } from '@nuxt/ui'
import type { PeerInput, PeerItem, SecretRef } from '~/types/management'

const props = defineProps<{
  initial?: PeerItem | PeerInput | null
  submitting?: boolean
  error?: string | null
}>()
const emit = defineEmits<{ submit: [PeerInput, boolean], cancel: [] }>()

const editing = computed(() => Boolean(props.initial && 'id' in props.initial))

const state = reactive({
  name: props.initial?.name ?? '',
  url: props.initial?.url ?? '',
  apiKey: (props.initial?.apiKey ?? null) as SecretRef | null,
  headers: { ...(props.initial?.headers ?? {}) } as Record<string, SecretRef>,
})

function validate(s: typeof state): FormError[] {
  const errors: FormError[] = []
  if (!s.name.trim())
    errors.push({ name: 'name', message: 'Give the peer a name.' })
  if (!s.url.trim())
    errors.push({ name: 'url', message: 'Enter the peer URL.' })
  if (!s.apiKey)
    errors.push({ name: 'apiKey', message: 'An API key is required.' })
  return errors
}

// Set by a shift-click on the submit button (the click fires before the form's
// submit). Enter-to-submit leaves it false → a normal, connectivity-checked save.
const forceNext = ref(false)
function onForceModifier(e: MouseEvent) {
  forceNext.value = e.shiftKey
}

function onSubmit() {
  const input: PeerInput = { name: state.name.trim(), url: state.url.trim(), apiKey: state.apiKey! }
  if (Object.keys(state.headers).length)
    input.headers = state.headers
  emit('submit', input, forceNext.value)
  forceNext.value = false
}
</script>

<template>
  <UForm :state="state" :validate="validate" class="space-y-4" @submit="onSubmit">
    <UFormField name="name" label="Name" required>
      <UInput v-model="state.name" placeholder="Friend's Jack" class="w-full" />
    </UFormField>
    <UFormField name="url" label="URL" required>
      <UInput v-model="state.url" placeholder="https://jack.friend.example" class="w-full" />
    </UFormField>
    <UFormField name="apiKey" label="API key" required>
      <SecretInput v-model="state.apiKey" :editing="editing" />
    </UFormField>
    <UFormField label="Headers" hint="Optional">
      <HeadersEditor v-model="state.headers" />
    </UFormField>

    <UAlert v-if="error" color="error" variant="soft" icon="i-ph-warning" :title="error" />

    <div class="flex justify-end gap-2 pt-2">
      <UButton label="Cancel" color="neutral" variant="ghost" @click="emit('cancel')" />
      <UButton
        type="submit"
        :loading="submitting"
        :label="submitting ? 'Saving…' : 'Save'"
        title="Shift-click to save even if the peer can't be reached (it'll retry later)"
        @click="onForceModifier"
      />
    </div>
  </UForm>
</template>
