<script setup lang="ts">
import { Icon } from '@iconify/vue'

withDefaults(defineProps<{
  label: string
  value: number | string
  caption: string
  icon: string
  tone?: 'neutral' | 'warning' | 'critical' | 'positive'
}>(), {
  tone: 'neutral',
})
</script>

<template>
  <article class="metric-card" :class="`metric-${tone}`">
    <span class="metric-icon"><Icon :icon="icon" /></span>
    <div>
      <p>{{ label }}</p>
      <strong>{{ value }}</strong>
      <small>{{ caption }}</small>
    </div>
  </article>
</template>
