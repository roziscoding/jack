<script setup lang="ts">
import type { AuthState } from '~/composables/useAuth'

const state = useAuthState()

// Resolve the auth state once on load (SSR + client). The BFF probes the
// management API and tells us which of the three states we're in.
const { data } = await useAsyncData('ping', () =>
  $fetch<{ status: AuthState['status'], mode: AuthState['mode'], message?: string }>('/api/ping'))

if (data.value)
  state.value = { status: data.value.status, mode: data.value.mode, message: data.value.message }
</script>

<template>
  <div class="min-h-screen">
    <template v-if="state.status === 'ok'">
      <NuxtLayout>
        <NuxtPage />
      </NuxtLayout>
    </template>
    <AuthScreen v-else />
  </div>
</template>
