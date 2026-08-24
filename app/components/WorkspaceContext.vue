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
  <nav class="panel flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between" aria-label="目前工作情境">
    <div class="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2 text-base font-semibold text-muted">
      <span class="inline-flex items-center gap-1"><Icon class="text-lg text-accent" :icon="mode === 'live' ? 'solar:bolt-circle-outline' : 'solar:history-outline'" />{{ mode === 'live' ? '即時站況' : '歷史資料' }}</span>
      <span class="inline-flex items-center gap-1"><Icon class="text-lg text-accent" icon="solar:map-point-outline" />{{ district || '全市' }}</span>
      <time v-if="formattedDataTime" class="inline-flex items-center gap-1" :datetime="dataTime"><Icon class="text-lg text-accent" icon="solar:clock-circle-outline" />資料 {{ formattedDataTime }}</time>
    </div>
    <NuxtLink :to="{ path: '/', query: query || {} }" class="inline-flex min-h-11 w-full shrink-0 items-center justify-center gap-1 rounded-md border border-line px-3 text-base font-bold text-accent transition-colors hover:border-line-strong hover:bg-panel-muted hover:text-accent-strong sm:w-auto">
      <Icon icon="solar:home-angle-outline" />回營運總覽
    </NuxtLink>
  </nav>
</template>
