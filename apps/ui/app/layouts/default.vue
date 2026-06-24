<script setup lang="ts">
const { state, logout } = useAuth()

const links = [
  { to: '/', label: 'Dashboard', icon: '◧' },
  { to: '/peers', label: 'Peers', icon: '⇄' },
  { to: '/servers', label: 'Servers', icon: '▤' },
  { to: '/downloads', label: 'Downloads', icon: '↓' },
  { to: '/settings', label: 'Settings', icon: '⚙' },
]

const loggingOut = ref(false)
async function onLogout() {
  loggingOut.value = true
  try {
    await logout()
  }
  finally {
    loggingOut.value = false
  }
}
</script>

<template>
  <div class="flex min-h-screen">
    <aside class="flex w-56 shrink-0 flex-col border-r border-slate-800 bg-slate-900/40">
      <div class="px-5 py-5">
        <NuxtLink to="/" class="text-xl font-semibold tracking-tight">
          jack
        </NuxtLink>
        <p class="text-xs text-slate-500">
          management console
        </p>
      </div>

      <nav class="flex-1 space-y-1 px-3">
        <NuxtLink
          v-for="link in links"
          :key="link.to"
          :to="link.to"
          class="flex items-center gap-3 rounded-lg px-3 py-2 text-sm text-slate-400 transition hover:bg-slate-800/60 hover:text-slate-100"
          active-class="bg-slate-800 text-slate-100"
        >
          <span class="w-4 text-center text-slate-500">{{ link.icon }}</span>
          {{ link.label }}
        </NuxtLink>
      </nav>

      <div class="border-t border-slate-800 px-3 py-4">
        <p class="px-3 pb-2 text-xs text-slate-600">
          auth: {{ state.mode === 'env' ? 'injected' : 'cookie' }}
        </p>
        <button
          v-if="state.mode === 'cookie'"
          :disabled="loggingOut"
          class="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm text-slate-400 transition hover:bg-slate-800/60 hover:text-slate-100 disabled:opacity-50"
          @click="onLogout"
        >
          <span class="w-4 text-center text-slate-500">⎋</span>
          {{ loggingOut ? 'Signing out…' : 'Sign out' }}
        </button>
      </div>
    </aside>

    <main class="flex-1 overflow-x-hidden">
      <div class="mx-auto max-w-6xl px-8 py-8">
        <slot />
      </div>
    </main>
  </div>
</template>
