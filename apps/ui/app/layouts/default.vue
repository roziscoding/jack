<script setup lang="ts">
import type { NavigationMenuItem } from '@nuxt/ui'

const { state, logout } = useAuth()

// A "jack" is a connector — the whole console is about what this node is plugged
// into (peers, *arr servers), so the nav leans on that connection vocabulary.
const items: NavigationMenuItem[] = [
  { label: 'Dashboard', icon: 'i-ph-gauge', to: '/', exact: true },
  { label: 'Connectors', icon: 'i-ph-plugs', to: '/connectors' },
  { label: 'Downloads', icon: 'i-ph-download-simple', to: '/downloads' },
  { label: 'Settings', icon: 'i-ph-gear-six', to: '/settings' },
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
  <UDashboardGroup unit="rem" storage-key="jack-dashboard">
    <UDashboardSidebar collapsible :default-size="13">
      <template #header="{ collapsed }">
        <NuxtLink to="/" class="flex items-center gap-2.5">
          <UIcon name="i-ph-plugs-connected" class="size-6 text-primary" />
          <span v-if="!collapsed" class="flex flex-col leading-tight">
            <span class="text-base font-semibold tracking-tight text-highlighted">jack</span>
            <span class="text-xs text-muted">management console</span>
          </span>
        </NuxtLink>
      </template>

      <template #default="{ collapsed }">
        <UNavigationMenu :collapsed="collapsed" :items="items" orientation="vertical" />
      </template>

      <template #footer="{ collapsed }">
        <div class="flex w-full items-center gap-1.5" :class="collapsed ? 'flex-col' : ''">
          <UButton
            v-if="state.mode === 'cookie'"
            :label="collapsed ? undefined : 'Sign out'"
            icon="i-ph-sign-out"
            color="neutral"
            variant="ghost"
            :loading="loggingOut"
            :block="!collapsed"
            :class="!collapsed && 'flex-1 justify-start'"
            @click="onLogout"
          />
          <span v-else-if="!collapsed" class="flex-1 truncate px-2.5 text-xs text-muted">
            Key injected by host
          </span>
          <UColorModeButton />
        </div>
      </template>
    </UDashboardSidebar>

    <slot />
  </UDashboardGroup>
</template>
