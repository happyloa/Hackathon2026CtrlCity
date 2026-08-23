<script setup lang="ts">
import { Icon } from '@iconify/vue'

const props = withDefaults(defineProps<{
  label: string
  value: number | string
  caption: string
  icon: string
  tone?: 'neutral' | 'warning' | 'critical' | 'positive'
}>(), {
  tone: 'neutral',
})

const toneClasses = {
  neutral: 'border-line bg-panel',
  warning: 'border-warning bg-warning-surface',
  critical: 'border-danger bg-danger-surface',
  positive: 'border-positive bg-positive-surface',
} as const
const iconClasses = {
  neutral: 'bg-panel-muted text-accent',
  warning: 'bg-warning-surface text-warning',
  critical: 'bg-danger-surface text-danger',
  positive: 'bg-positive-surface text-positive',
} as const
</script>

<template>
  <article class="flex min-w-0 items-start gap-3 rounded-xl border p-4 shadow-sm" :class="toneClasses[props.tone]">
    <span class="grid size-11 shrink-0 place-items-center rounded-lg text-xl" :class="iconClasses[props.tone]"><Icon :icon="props.icon" /></span>
    <div class="min-w-0">
      <p class="m-0 text-base font-semibold text-muted">{{ props.label }}</p>
      <strong class="mt-1 block break-words text-2xl font-bold leading-tight text-ink">{{ props.value }}</strong>
      <small class="mt-1 block text-base leading-6 text-muted">{{ props.caption }}</small>
    </div>
  </article>
</template>
