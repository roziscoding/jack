<script setup lang="ts">
const { state, login, refresh } = useAuth()

const key = ref('')
const submitting = ref(false)
const error = ref<string | null>(null)

async function submit() {
  if (!key.value.trim())
    return
  submitting.value = true
  error.value = null
  try {
    await login(key.value.trim())
    key.value = ''
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
  <div class="flex min-h-screen items-center justify-center px-4">
    <div class="w-full max-w-md">
      <div class="mb-8 text-center">
        <h1 class="text-3xl font-semibold tracking-tight">
          jack
        </h1>
        <p class="mt-1 text-sm text-slate-400">
          management console
        </p>
      </div>

      <!-- Loading -->
      <div v-if="state.status === 'loading'" class="rounded-xl border border-slate-800 bg-slate-900/60 p-6 text-center text-slate-400">
        Checking management API…
      </div>

      <!-- Management API disabled on the server -->
      <div v-else-if="state.status === 'disabled'" class="rounded-xl border border-amber-900/60 bg-amber-950/30 p-6">
        <h2 class="font-medium text-amber-200">
          Management API is disabled
        </h2>
        <p class="mt-2 text-sm text-amber-100/70">
          The jack server has no <code class="rounded bg-slate-800 px-1 py-0.5 text-xs">MANAGEMENT_KEY</code> set, so the
          management API isn't running. Set it on the server and restart to enable this console.
        </p>
        <button class="mt-4 text-sm font-medium text-amber-200 hover:underline" @click="refresh">
          Retry
        </button>
      </div>

      <!-- Unexpected error -->
      <div v-else-if="state.status === 'error'" class="rounded-xl border border-rose-900/60 bg-rose-950/30 p-6">
        <h2 class="font-medium text-rose-200">
          Something went wrong
        </h2>
        <p class="mt-2 text-sm text-rose-100/70">
          {{ state.message ?? 'Unexpected error talking to the management API.' }}
        </p>
        <button class="mt-4 text-sm font-medium text-rose-200 hover:underline" @click="refresh">
          Retry
        </button>
      </div>

      <!-- Needs key: cookie-mode login prompt -->
      <form v-else class="rounded-xl border border-slate-800 bg-slate-900/60 p-6" @submit.prevent="submit">
        <h2 class="font-medium">
          Enter management key
        </h2>
        <p class="mt-1 text-sm text-slate-400">
          This is stored in a secure, http-only cookie — never exposed to the page.
        </p>
        <input
          v-model="key"
          type="password"
          autocomplete="current-password"
          placeholder="X-Management-Key"
          class="mt-4 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm outline-none focus:border-brand-500"
        >
        <p v-if="error" class="mt-2 text-sm text-rose-400">
          {{ error }}
        </p>
        <button
          type="submit"
          :disabled="submitting || !key.trim()"
          class="mt-4 w-full rounded-lg bg-brand-600 px-3 py-2 text-sm font-medium text-white transition hover:bg-brand-500 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {{ submitting ? 'Validating…' : 'Unlock' }}
        </button>
      </form>
    </div>
  </div>
</template>
