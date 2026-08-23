<script setup lang="ts">
import { Icon } from '@iconify/vue'

defineProps<{ busy?: boolean }>()
defineEmits<{ retry: [] }>()
</script>

<template>
  <button type="button" class="ml-auto inline-flex min-h-11 items-center justify-center gap-1 rounded-md border border-line-strong bg-panel px-3 text-base font-bold text-accent transition-colors hover:bg-panel-muted hover:text-accent-strong" :disabled="busy" @click="$emit('retry')">
    <Icon :icon="busy ? 'svg-spinners:ring-resize' : 'solar:refresh-circle-outline'" />{{ busy ? '重新載入中…' : '重新載入' }}
  </button>
</template>
