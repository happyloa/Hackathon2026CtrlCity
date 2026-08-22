<script setup lang="ts">
import { Icon } from '@iconify/vue'
import type { DataMode } from '~/shared/ops'

const props = defineProps<{
  mode: DataMode
  district?: string
  dataTime?: string
  query?: Record<string, string>
}>()

const formattedDataTime = computed(() => {
  if (!props.dataTime) return ''
  const date = new Date(props.dataTime)
  if (Number.isNaN(date.getTime())) return props.dataTime
  return new Intl.DateTimeFormat('zh-TW', {
    timeZone: 'Asia/Taipei',
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date)
})
</script>

<template>
  <nav class="workspace-context panel" aria-label="目前工作情境">
    <div class="workspace-context__items">
      <span><Icon :icon="mode === 'live' ? 'solar:bolt-circle-outline' : 'solar:history-outline'" />{{ mode === 'live' ? '即時調度' : '歷史演練' }}</span>
      <span><Icon icon="solar:map-point-outline" />{{ district || '全市' }}</span>
      <time v-if="formattedDataTime" :datetime="dataTime"><Icon icon="solar:clock-circle-outline" />資料 {{ formattedDataTime }}</time>
    </div>
    <NuxtLink :to="{ path: '/', query: query || {} }" class="workspace-context__link">
      <Icon icon="solar:tuning-2-outline" />回工作台調整篩選
    </NuxtLink>
  </nav>
</template>

<style scoped>
.workspace-context { display: flex; align-items: center; justify-content: space-between; gap: 14px; padding: 11px 14px; }
.workspace-context__items { display: flex; align-items: center; flex-wrap: wrap; gap: 8px 16px; min-width: 0; }
.workspace-context__items span, .workspace-context__items time, .workspace-context__link { display: inline-flex; align-items: center; gap: 5px; font-size: 16px; font-weight: 700; }
.workspace-context__items span, .workspace-context__items time { color: var(--muted); }
.workspace-context__items svg, .workspace-context__link { color: var(--teal-dark); }
.workspace-context__link { flex: 0 0 auto; min-height: 44px; padding: 8px 10px; border: 1px solid var(--line); border-radius: 4px; }
.workspace-context__link:hover { color: var(--ink); border-color: var(--line-strong); background: var(--surface-muted); }
@media (max-width: 620px) { .workspace-context { align-items: stretch; flex-direction: column; }.workspace-context__link { justify-content: center; width: 100%; } }
</style>
