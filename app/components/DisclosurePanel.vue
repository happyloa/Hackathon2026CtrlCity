<script setup lang="ts">
import { Icon } from '@iconify/vue'

const props = withDefaults(defineProps<{
  title: string
  description?: string
  icon?: string
  defaultOpen?: boolean
}>(), {
  description: '',
  icon: 'solar:alt-arrow-down-outline',
  defaultOpen: false,
})

const expanded = ref(props.defaultOpen)
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
      <span class="flex min-w-0 flex-1 items-center gap-2"><Icon class="shrink-0 text-lg text-accent" :icon="icon" /> <span class="break-words">{{ title }}</span></span>
      <small v-if="description" class="hidden min-w-0 text-right text-base font-semibold text-muted sm:block">{{ description }}</small>
      <Icon class="shrink-0 text-lg text-accent transition-transform" :class="expanded ? arrowClasses.open : arrowClasses.closed" icon="solar:alt-arrow-down-outline" />
    </button>
    <Transition name="disclosure">
      <div v-if="expanded">
        <slot />
      </div>
    </Transition>
  </section>
</template>
