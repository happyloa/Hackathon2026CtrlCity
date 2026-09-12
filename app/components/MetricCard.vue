<script setup lang="ts">
import { Icon } from '@iconify/vue'

const props = withDefaults(defineProps<{
  label: string
  value: number | string
  caption: string
  icon: string
  tone?: 'neutral' | 'warning' | 'critical' | 'positive'
  tooltip?: string
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
    <span class="grid size-11 shrink-0 place-items-center rounded-lg icon-md" :class="iconClasses[props.tone]"><Icon :icon="props.icon" /></span>
    <div class="min-w-0">
      <div class="flex min-w-0 flex-wrap items-center gap-1">
        <p class="m-0 min-w-0 break-words text-body1 font-semibold text-muted">{{ props.label }}</p>
        <span v-if="props.tooltip" class="group/tip relative inline-flex">
          <button
            type="button"
            class="grid size-5 shrink-0 place-items-center rounded-full text-muted hover:text-ink"
            :aria-label="`${props.label} 說明`"
          ><Icon icon="solar:question-circle-linear" /></button>
          <span
            class="pointer-events-none absolute bottom-full left-1/2 z-10 mb-2 w-56 max-w-[calc(100vw-2rem)] -translate-x-1/2 rounded-lg border border-line-strong bg-surface p-2.5 text-body2 font-normal leading-5 text-ink opacity-0 shadow-lg transition-opacity group-hover/tip:opacity-100 group-focus-within/tip:opacity-100"
          >{{ props.tooltip }}</span>
        </span>
      </div>
      <strong class="mt-1 block break-words text-h5 font-bold leading-tight text-ink">{{ props.value }}</strong>
      <small class="mt-1 block text-body2 text-muted">{{ props.caption }}</small>
    </div>
  </article>
</template>
