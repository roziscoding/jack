<script setup lang="ts">
/**
 * One numeric key of the config file. Empty means "not in the file", so jack's own
 * default applies — the placeholder shows that default, and the hint always states
 * the value actually in effect (durations read back as "30 min", not "1800000").
 */
const props = withDefaults(defineProps<{
  /** The config file key, used for the field's name and error mapping. */
  name: string
  label: string
  description?: string
  /** jack's default when the key is absent from the config file. */
  defaultValue: number
  /** `ms` renders the effective value as a duration; `count` leaves it as a number. */
  unit?: 'ms' | 'count'
  min?: number
  disabled?: boolean
}>(), { unit: 'count', min: 0 })

const model = defineModel<number | null>()

const readable = (value: number) => (props.unit === 'ms' ? formatDurationMs(value) : String(value))

const hint = computed(() =>
  model.value == null ? `Default · ${readable(props.defaultValue)}` : readable(model.value),
)
</script>

<template>
  <UFormField
    :name="name"
    :label="label"
    :description="description"
    :hint="hint"
    :ui="{ hint: 'font-mono text-xs text-dimmed' }"
  >
    <UInputNumber
      v-model="model"
      :min="min"
      :disabled="disabled"
      :increment="false"
      :decrement="false"
      :placeholder="String(defaultValue)"
      class="w-full"
    />
  </UFormField>
</template>
