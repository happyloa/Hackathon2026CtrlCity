<script setup lang="ts">
import { LoaderCircle, RefreshCw } from '@lucide/vue'

defineProps<{ busy?: boolean }>()
defineEmits<{ retry: [] }>()
</script>

<template>
  <button type="button" class="ml-auto inline-flex min-h-11 items-center justify-center gap-1 rounded-md border border-line-strong bg-panel px-3 text-body1 font-bold text-accent transition-colors hover:bg-panel-muted hover:text-accent-strong" :disabled="busy" @click="$emit('retry')">
    <component :is="busy ? LoaderCircle : RefreshCw" :class="{ 'icon-spin': busy }" style="width: 1em; height: 1em" :stroke-width="2" aria-hidden="true" />{{ busy ? '重新載入中…' : '重新載入' }}
  </button>
</template>

<style scoped>
.icon-spin { animation: icon-spin 1s linear infinite; }
@keyframes icon-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .icon-spin { animation: none; } }
</style>
