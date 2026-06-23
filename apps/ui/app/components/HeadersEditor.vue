<script setup lang="ts">
const props = defineProps<{ modelValue: Record<string, string> }>()
const emit = defineEmits<{ 'update:modelValue': [Record<string, string>] }>()

interface Row { key: string, value: string }

const rows = ref<Row[]>(Object.entries(props.modelValue ?? {}).map(([key, value]) => ({ key, value })))

function sync() {
  const out: Record<string, string> = {}
  for (const row of rows.value) {
    const k = row.key.trim()
    if (k)
      out[k] = row.value
  }
  emit('update:modelValue', out)
}

function add() {
  rows.value.push({ key: '', value: '' })
}
function remove(index: number) {
  rows.value.splice(index, 1)
  sync()
}

watch(rows, sync, { deep: true })
</script>

<template>
  <div class="space-y-2">
    <div v-for="(row, index) in rows" :key="index" class="flex gap-2">
      <input
        v-model="row.key"
        placeholder="Header"
        class="w-1/3 rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm outline-none focus:border-brand-500"
      >
      <input
        v-model="row.value"
        placeholder="Value"
        class="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm outline-none focus:border-brand-500"
      >
      <button type="button" class="px-2 text-slate-500 hover:text-rose-400" @click="remove(index)">
        ✕
      </button>
    </div>
    <button type="button" class="text-xs font-medium text-brand-400 hover:underline" @click="add">
      + Add header
    </button>
  </div>
</template>
