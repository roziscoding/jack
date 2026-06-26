<script setup lang="ts">
import type { NavigationMenuItem } from '@nuxt/ui'

const { state, logout } = useAuth()

// Peers and *arr servers are managed as sections under Settings, so the nav is
// just the three live views plus configuration.
const items: NavigationMenuItem[] = [
  { label: 'Dashboard', icon: 'i-ph-gauge', to: '/', exact: true },
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
        <NuxtLink v-if="!collapsed" to="/" class="flex min-w-0 items-center gap-2.5">
          <UIcon name="i-ph-plugs-connected" class="size-6 shrink-0 text-primary" />
          <span class="truncate text-base font-semibold tracking-tight text-highlighted">jack</span>
        </NuxtLink>
        <UDashboardSidebarCollapse icon="i-ph-sidebar-simple" :class="collapsed ? 'mx-auto' : 'ms-auto'" />
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
