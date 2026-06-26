<script setup lang="ts">
import type { FormError } from '@nuxt/ui'

const { state, login, refresh } = useAuth()

const form = reactive({ key: '' })
const submitting = ref(false)
const error = ref<string | null>(null)

function validate(s: typeof form): FormError[] {
  return s.key.trim() ? [] : [{ name: 'key', message: 'Enter your management key.' }]
}

async function onSubmit() {
  submitting.value = true
  error.value = null
  try {
    await login(form.key.trim())
    form.key = ''
  }
  catch (err) {
    const status = (err as { response?: { status?: number } })?.response?.status
    error.value = status === 401
      ? 'That management key was rejected.'
      : 'Could not validate the key. Is the management API reachable?'
  }
  finally {
    submitting.value = false
  }
}
</script>

<template>
  <div class="flex min-h-screen items-center justify-center p-4">
    <div class="w-full max-w-md space-y-6">
      <div class="flex flex-col items-center gap-2 text-center">
        <UIcon name="i-ph-plugs-connected" class="size-9 text-primary" />
        <div>
          <h1 class="text-2xl font-semibold tracking-tight text-highlighted">
            jack
          </h1>
          <p class="text-sm text-muted">
            management console
          </p>
        </div>
      </div>

      <!-- Loading -->
      <UCard v-if="state.status === 'loading'">
        <p class="flex items-center justify-center gap-2 text-sm text-muted">
          <UIcon name="i-ph-circle-notch" class="size-4 animate-spin" />
          Checking management API…
        </p>
      </UCard>

      <!-- Management API disabled on the server -->
      <UAlert
        v-else-if="state.status === 'disabled'"
        color="warning"
        variant="soft"
        icon="i-ph-warning"
        title="Management API is disabled"
        :actions="[{ label: 'Retry', color: 'warning', variant: 'soft', onClick: refresh }]"
      >
        <template #description>
          The jack server has no <code class="rounded bg-elevated px-1 py-0.5 text-xs">MANAGEMENT_KEY</code> set, so the
          management API isn't running. Set it on the server and restart to enable this console.
        </template>
      </UAlert>

      <!-- Unexpected error -->
      <UAlert
        v-else-if="state.status === 'error'"
        color="error"
        variant="soft"
        icon="i-ph-x-circle"
        title="Something went wrong"
        :description="state.message ?? 'Unexpected error talking to the management API.'"
        :actions="[{ label: 'Retry', color: 'error', variant: 'soft', onClick: refresh }]"
      />

      <!-- Needs key: cookie-mode login prompt -->
      <UCard v-else>
        <UForm :state="form" :validate="validate" class="space-y-4" @submit="onSubmit">
          <div>
            <h2 class="font-medium text-highlighted">
              Enter management key
            </h2>
            <p class="mt-1 text-sm text-muted">
              This is stored in a secure, http-only cookie — never exposed to the page.
            </p>
          </div>

          <UFormField name="key" :error="error ?? undefined">
            <UInput
              v-model="form.key"
              type="password"
              autocomplete="current-password"
              placeholder="X-Management-Key"
              icon="i-ph-key"
              class="w-full"
            />
          </UFormField>

          <UButton
            type="submit"
            block
            :loading="submitting"
            :label="submitting ? 'Validating…' : 'Unlock'"
          />
        </UForm>
      </UCard>
    </div>
  </div>
</template>
