<script setup lang="ts">
// Static placeholder that mirrors CatalogPosterCard's layout so the grid keeps its
// shape while the catalog request is in flight.
</script>

<template>
  <div class="flex flex-col gap-2">
    <div class="aspect-[2/3] animate-pulse rounded-lg bg-muted ring-1 ring-default" />
    <div class="min-w-0 space-y-1.5">
      <div class="h-3.5 w-3/4 animate-pulse rounded bg-muted" />
      <div class="h-3 w-12 animate-pulse rounded bg-muted" />
    </div>
  </div>
</template>
