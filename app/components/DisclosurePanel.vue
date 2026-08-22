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
</script>

<template>
  <section class="disclosure-panel" :class="{ 'is-open': expanded }">
    <button class="disclosure-trigger" type="button" :aria-expanded="expanded" @click="expanded = !expanded">
      <span class="disclosure-title"><Icon :icon="icon" /> {{ title }}</span>
      <small v-if="description" class="disclosure-description">{{ description }}</small>
      <Icon class="disclosure-arrow" icon="solar:alt-arrow-down-outline" />
    </button>
    <Transition name="disclosure">
      <div v-if="expanded" class="disclosure-content">
        <slot />
      </div>
    </Transition>
  </section>
</template>

<style scoped>
.disclosure-panel { overflow: hidden; }
.disclosure-trigger { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: 12px; width: 100%; padding: 13px 16px; color: var(--ink); background: transparent; border: 0; font: inherit; font-size: 16px; font-weight: 800; text-align: left; }
.disclosure-title { display: inline-flex; align-items: center; gap: 7px; min-width: 0; }
.disclosure-title svg, .disclosure-arrow { color: var(--teal-dark); font-size: 19px; }
.disclosure-description { min-width: 0; color: var(--muted); font-size: 16px; font-weight: 650; text-align: right; }
.disclosure-arrow { transition: transform .18s ease; }
.disclosure-panel.is-open .disclosure-trigger { border-bottom: 1px solid var(--line); }
.disclosure-panel.is-open .disclosure-arrow { transform: rotate(180deg); }
.disclosure-trigger:hover, .disclosure-trigger:focus-visible { background: var(--surface-muted); outline: 0; }
.disclosure-enter-active, .disclosure-leave-active { transition: opacity .16s ease, transform .16s ease; }
.disclosure-enter-from, .disclosure-leave-to { opacity: 0; transform: translateY(-4px); }

@media (max-width: 620px) {
  .disclosure-trigger { grid-template-columns: minmax(0, 1fr) auto; }
  .disclosure-description { display: none; }
}

@media (prefers-reduced-motion: reduce) { .disclosure-enter-active, .disclosure-leave-active { transition: none; } }
</style>
