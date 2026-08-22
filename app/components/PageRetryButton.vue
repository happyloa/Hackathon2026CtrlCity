<script setup lang="ts">
import { Icon } from '@iconify/vue'

defineProps<{ busy?: boolean }>()
defineEmits<{ retry: [] }>()
</script>

<template>
  <button type="button" class="page-retry-button" :disabled="busy" @click="$emit('retry')">
    <Icon :icon="busy ? 'svg-spinners:ring-resize' : 'solar:refresh-circle-outline'" />{{ busy ? '重新載入中…' : '重新載入' }}
  </button>
</template>

<style scoped>
.page-retry-button { display: inline-flex; align-items: center; justify-content: center; gap: 5px; min-height: 44px; margin-left: auto; padding: 7px 10px; color: var(--teal-dark); background: var(--panel); border: 1px solid var(--line-strong); border-radius: 4px; font: inherit; font-size: 16px; font-weight: 800; }
.page-retry-button:hover:not(:disabled) { color: var(--ink); background: var(--surface-muted); }
.page-retry-button:disabled { cursor: wait; opacity: .7; }
</style>
