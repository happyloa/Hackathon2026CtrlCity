<script setup lang="ts">
import { CalendarDays, ChevronDown, Info, List } from '@lucide/vue'
import type { Component } from 'vue'

const props = withDefaults(defineProps<{
  title: string
  description?: string
  icon?: string
  defaultOpen?: boolean
}>(), {
  description: '',
  defaultOpen: false,
})

const expanded = ref(props.defaultOpen)
// Keep existing string callers compatible while rendering one icon family.
const legacyIcons: Record<string, Component> = {
  'solar:calendar-outline': CalendarDays,
  'solar:list-outline': List,
  'solar:info-circle-outline': Info,
}
const disclosureIcon = computed(() => props.icon ? legacyIcons[props.icon] ?? Info : null)
const disclosureClasses = {
  closed: '',
  open: 'border-b border-line',
} as const
const arrowClasses = {
  closed: 'rotate-0',
  open: 'rotate-180',
} as const
</script>

<template>
  <section class="overflow-hidden">
    <button class="flex min-h-11 w-full items-center gap-3 p-4 text-left text-base font-bold text-ink transition-colors hover:bg-panel-muted" :class="expanded ? disclosureClasses.open : disclosureClasses.closed" type="button" :aria-expanded="expanded" @click="expanded = !expanded">
      <span class="flex min-w-0 flex-1 items-center gap-2"><component v-if="disclosureIcon" class="shrink-0 text-lg text-accent" :is="disclosureIcon" style="width: 1em; height: 1em" :stroke-width="2" aria-hidden="true" /> <span class="break-words">{{ title }}</span></span>
      <small v-if="description" class="hidden min-w-0 text-right text-base font-semibold text-muted sm:block">{{ description }}</small>
      <ChevronDown class="shrink-0 text-lg text-accent transition-transform" :class="expanded ? arrowClasses.open : arrowClasses.closed" style="width: 1em; height: 1em" :stroke-width="2" aria-hidden="true" />
    </button>
    <Transition name="disclosure">
      <div v-if="expanded">
        <slot />
      </div>
    </Transition>
  </section>
</template>
