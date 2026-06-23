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
      <input
        v-model="row.key"
        placeholder="Header"
        class="w-1/3 shrink-0 rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm outline-none focus:border-brand-500"
      >
      <div class="flex-1">
        <SecretInput v-model="row.value" />
      </div>
      <button type="button" class="px-2 py-2 text-slate-500 hover:text-rose-400" @click="remove(index)">
        ✕
      </button>
    </div>
    <button type="button" class="text-xs font-medium text-brand-400 hover:underline" @click="add">
      + Add header
    </button>
  </div>
</template>
