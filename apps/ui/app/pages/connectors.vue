<script setup lang="ts">
// Connectors = everything this node is plugged into: peer jacks it federates
// with, and the *arr servers it reads from / pushes to. Each is its own section
// with its own data, add action, and overlays.
</script>

<template>
  <UDashboardPanel id="connectors">
    <template #header>
      <UDashboardNavbar title="Connectors">
        <template #leading>
          <UDashboardSidebarCollapse />
        </template>
      </UDashboardNavbar>
    </template>

    <template #body>
      <div class="space-y-10">
        <PeersSection />
        <USeparator />
        <ServersSection />
      </div>
    </template>
  </UDashboardPanel>
</template>
