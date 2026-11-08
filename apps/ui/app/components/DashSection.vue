<script setup lang="ts">
defineProps<{ title: string }>()

// Every dashboard section folds; they all start open.
const open = defineModel<boolean>('open', { default: true })
</script>

<template>
  <section>
    <div class="mb-3 flex items-center justify-between gap-2">
      <button
        type="button"
        class="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-muted hover:text-default"
        :aria-expanded="open"
        @click="open = !open"
      >
        <UIcon name="i-ph-caret-right" class="size-3.5 transition-transform" :class="open && 'rotate-90'" />
        {{ title }}
      </button>
      <slot v-if="open" name="actions" />
    </div>
    <div v-show="open">
      <slot />
    </div>
  </section>
</template>
