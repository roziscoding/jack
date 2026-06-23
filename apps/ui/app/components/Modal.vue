<script setup lang="ts">
defineProps<{ title: string }>()
const emit = defineEmits<{ close: [] }>()

function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape')
    emit('close')
}

onMounted(() => window.addEventListener('keydown', onKey))
onUnmounted(() => window.removeEventListener('keydown', onKey))
</script>

<template>
  <div class="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/60 p-4 py-10" @click.self="emit('close')">
    <div class="w-full max-w-lg rounded-xl border border-slate-800 bg-slate-900 shadow-2xl">
      <div class="flex items-center justify-between border-b border-slate-800 px-5 py-4">
        <h2 class="font-medium">
          {{ title }}
        </h2>
        <button class="text-slate-500 transition hover:text-slate-200" @click="emit('close')">
          ✕
        </button>
      </div>
      <div class="px-5 py-5">
        <slot />
      </div>
    </div>
  </div>
</template>
