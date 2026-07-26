<script setup lang="ts">
import type { DownloadItem } from '~/types/management'
import type { DownloadAction } from '~/utils/download-actions'

const props = defineProps<{
  download: DownloadItem
  pending?: DownloadAction
}>()

const emit = defineEmits<{
  action: [action: DownloadAction]
}>()

const actionPresentation: Record<DownloadAction, { label: string, icon: string, color: 'neutral' | 'error' | 'primary' }> = {
  cancel: { label: 'Cancel', icon: 'i-ph-x-circle', color: 'neutral' },
  retry: { label: 'Retry', icon: 'i-ph-arrow-clockwise', color: 'primary' },
  delete: { label: 'Delete', icon: 'i-ph-trash', color: 'error' },
}

const actions = computed(() => downloadActionsFor(props.download))
</script>

<template>
  <div class="flex flex-wrap items-center justify-end gap-1">
    <UButton
      v-for="action in actions"
      :key="action"
      :aria-label="`${actionPresentation[action].label} ${download.filename}`"
      :title="actionPresentation[action].label"
      :icon="actionPresentation[action].icon"
      :color="actionPresentation[action].color"
      :loading="pending === action"
      :disabled="pending !== undefined"
      variant="ghost"
      size="xs"
      @click="emit('action', action)"
    >
      <span class="sr-only">{{ actionPresentation[action].label }}</span>
    </UButton>
  </div>
</template>
