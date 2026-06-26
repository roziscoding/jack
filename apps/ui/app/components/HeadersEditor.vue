<script setup lang="ts">
import type { SecretRef } from '~/types/management'

const props = defineProps<{ modelValue: Record<string, SecretRef> }>()
const emit = defineEmits<{ 'update:modelValue': [Record<string, SecretRef>] }>()

interface Row { key: string, value: SecretRef | null }

const rows = ref<Row[]>(
  Object.entries(props.modelValue ?? {}).map(([key, value]) => ({ key, value })),
)

function sync() {
  const out: Record<string, SecretRef> = {}
  for (const row of rows.value) {
    const k = row.key.trim()
    // Drop incomplete rows (missing name or an empty/cleared value).
    if (k && row.value !== null && row.value !== '')
      out[k] = row.value
  }
  emit('update:modelValue', out)
}

function add() {
  rows.value.push({ key: '', value: null })
}
function remove(index: number) {
  rows.value.splice(index, 1)
  sync()
}

watch(rows, sync, { deep: true })
</script>

<template>
  <div class="space-y-2">
    <div v-for="(row, index) in rows" :key="index" class="flex items-start gap-2">
      <UInput v-model="row.key" placeholder="Header" class="w-1/3 shrink-0" />
      <div class="flex-1">
        <SecretInput v-model="row.value" />
      </div>
      <UButton
        color="neutral"
        variant="ghost"
        icon="i-ph-x"
        aria-label="Remove header"
        @click="remove(index)"
      />
    </div>
    <UButton variant="link" size="sm" icon="i-ph-plus" label="Add header" class="px-0" @click="add" />
  </div>
</template>
