<script setup lang="ts">
import type { FormError } from '@nuxt/ui'
import type { CreatedQuickLink, QuickLinkInput } from '~/types/management'

const props = defineProps<{ externalUrl: string }>()
const emit = defineEmits<{ generated: [] }>()
const open = defineModel<boolean>('open', { required: true })
const { request, extractError } = useManagement()

const generated = ref<CreatedQuickLink | null>(null)
const generating = ref(false)
const copied = ref(false)
const error = ref<string | null>(null)
const state = reactive({ name: '', description: '' })
const modalOpen = computed({
  get: () => open.value,
  set: (value) => {
    if (!value && generating.value)
      return
    open.value = value
  },
})

function suggestedName(): string {
  try {
    return new URL(props.externalUrl).hostname
  }
  catch {
    return 'My Jack'
  }
}

function reset() {
  generated.value = null
  generating.value = false
  copied.value = false
  error.value = null
  state.name = suggestedName()
  state.description = ''
}

watch(open, (isOpen) => {
  if (isOpen)
    reset()
  else
    generated.value = null
})

function validate(s: typeof state): FormError[] {
  return s.name.trim() ? [] : [{ name: 'name', message: 'Give this shared connection a name.' }]
}

async function generate() {
  if (generating.value)
    return
  generating.value = true
  error.value = null
  try {
    const input: QuickLinkInput = {
      name: state.name.trim(),
      description: state.description.trim() || null,
      expiresAt: null,
    }
    generated.value = await request<CreatedQuickLink>('quick-links', { method: 'POST', body: input })
    emit('generated')
  }
  catch (err) {
    error.value = extractError(err, 'Could not generate the quick link.')
  }
  finally {
    generating.value = false
  }
}

async function copyLink() {
  if (!generated.value)
    return
  try {
    await navigator.clipboard.writeText(generated.value.link)
    copied.value = true
    setTimeout(() => (copied.value = false), 2000)
  }
  catch {
    error.value = 'Could not copy the quick link. Select and copy it manually.'
  }
}

function close() {
  if (generating.value)
    return
  generated.value = null
  open.value = false
}
</script>

<template>
  <UModal v-model:open="modalOpen" title="Generate quick link" :dismissible="!generating" :ui="{ footer: 'justify-end' }">
    <template #body>
      <div class="space-y-4">
        <UAlert
          color="warning"
          variant="soft"
          icon="i-ph-warning"
          title="This quick link grants access to your Jack instance."
          description="It contains credentials. Do not publish it; share it only through a secure channel."
        />

        <UForm v-if="!generated" :state="state" :validate="validate" class="space-y-4" @submit="generate">
          <UFormField
            name="name"
            label="Suggested peer name"
            description="Your friend can review and change this before adding the peer."
            required
          >
            <UInput v-model="state.name" :maxlength="100" class="w-full" />
          </UFormField>
          <UFormField name="description" label="Key description" hint="Optional">
            <UTextarea v-model="state.description" :maxlength="500" :rows="2" placeholder="Who this link is for" class="w-full" />
          </UFormField>
          <UAlert v-if="error" color="error" variant="soft" icon="i-ph-warning" :title="error" />
          <div class="flex justify-end gap-2 pt-2">
            <UButton label="Cancel" color="neutral" variant="ghost" :disabled="generating" @click="close" />
            <UButton type="submit" label="Generate link" :loading="generating" />
          </div>
        </UForm>

        <template v-else>
          <UFormField label="Quick link" description="Shown only in this dialog. Closing it discards the plaintext from the UI.">
            <UTextarea :model-value="generated.link" readonly :rows="6" class="w-full font-mono text-xs" />
          </UFormField>
          <UAlert v-if="error" color="error" variant="soft" icon="i-ph-warning" :title="error" />
          <div class="flex justify-end gap-2">
            <UButton label="Close" color="neutral" variant="ghost" @click="close" />
            <UButton :label="copied ? 'Copied' : 'Copy quick link'" :icon="copied ? 'i-ph-check' : 'i-ph-copy'" @click="copyLink" />
          </div>
        </template>
      </div>
    </template>
  </UModal>
</template>
