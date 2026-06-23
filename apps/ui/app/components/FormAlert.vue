<script setup lang="ts">
defineProps<{ message: string }>()
</script>

<template>
  <!-- Inline form alert. The rose dot mirrors StatusBadge's "Error" state so a
  failed save reads as the same signal users see on the connector in the table. -->
  <div
    role="alert"
    class="flex items-start gap-2.5 rounded-lg border border-rose-900/60 bg-rose-950/30 px-3.5 py-3 text-sm leading-relaxed text-rose-200"
  >
    <span class="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-rose-400" aria-hidden="true" />
    <span>{{ message }}</span>
  </div>
</template>
