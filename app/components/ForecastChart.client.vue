<script setup lang="ts">
import type { StationHistoryPoint } from '~/shared/ops'

type ProjectionPoint = {
  label: string
  bikes: number
  docks: number
}

const props = defineProps<{
  history: StationHistoryPoint[]
  stationName: string
  capacity?: number
  projections?: ProjectionPoint[]
}>()

const root = ref<HTMLElement | null>(null)
let chart: import('echarts').ECharts | undefined
let observer: ResizeObserver | undefined
let themeObserver: MutationObserver | undefined

function draw() {
  if (!root.value || !chart) return
  const isDark = document.documentElement.dataset.theme === 'dark'
  const palette = isDark
    ? { tooltip: '#101514', text: '#b5c2bb', axis: '#62746b', split: '#2b3732' }
    : { tooltip: '#1d2926', text: '#55635f', axis: '#a9b7af', split: '#e0e6e0' }
  const historyLabels = props.history.map(point => new Intl.DateTimeFormat('zh-TW', {
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date(point.at)))
  const projections = props.projections || []
  const labels = [...historyLabels, ...projections.map(point => point.label)]
  const historyBikes = [...props.history.map(point => point.bikes), ...projections.map(() => null)]
  const historyDocks = [...props.history.map(point => point.docks), ...projections.map(() => null)]
  const connector = Math.max(0, props.history.length - 1)
  const projectedBikes = projections.length
    ? [...Array(connector).fill(null), props.history.at(-1)?.bikes ?? null, ...projections.map(point => point.bikes)]
    : []
  const projectedDocks = projections.length
    ? [...Array(connector).fill(null), props.history.at(-1)?.docks ?? null, ...projections.map(point => point.docks)]
    : []
  chart.setOption({
    animationDuration: 450,
    grid: { left: 8, right: 8, top: 18, bottom: 8, containLabel: true },
    tooltip: {
      trigger: 'axis',
      backgroundColor: palette.tooltip,
      borderWidth: 0,
      textStyle: { color: '#fff', fontFamily: 'Noto Sans TC', fontSize: 16 },
    },
    xAxis: { type: 'category', data: labels, boundaryGap: false, axisLabel: { color: palette.text, fontSize: 16 }, axisLine: { lineStyle: { color: palette.axis } }, axisTick: { show: false } },
    yAxis: { type: 'value', min: 0, max: props.capacity || undefined, splitNumber: 3, axisLabel: { color: palette.text, fontSize: 16 }, splitLine: { lineStyle: { color: palette.split } } },
    series: [
      { name: '可借車', type: 'line', smooth: false, symbol: 'none', lineStyle: { width: 2.5, color: '#1e6f62' }, data: historyBikes },
      { name: '可還位', type: 'line', smooth: false, symbol: 'none', lineStyle: { width: 2.2, color: '#8a5a09' }, data: historyDocks },
      ...(projections.length ? [
        { name: '基線推估可借車', type: 'line', smooth: false, symbol: 'circle', symbolSize: 6, lineStyle: { width: 2, type: 'dashed', color: '#1e6f62' }, data: projectedBikes },
        { name: '基線推估可還位', type: 'line', smooth: false, symbol: 'circle', symbolSize: 6, lineStyle: { width: 2, type: 'dashed', color: '#8a5a09' }, data: projectedDocks },
      ] : []),
    ],
  }, { notMerge: true })
}

onMounted(async () => {
  const echarts = await import('echarts')
  if (!root.value) return
  chart = echarts.init(root.value)
  draw()
  observer = new ResizeObserver(() => chart?.resize())
  observer.observe(root.value)
  themeObserver = new MutationObserver(draw)
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
})

watch(() => props.history, draw, { deep: true })
onBeforeUnmount(() => {
  observer?.disconnect()
  themeObserver?.disconnect()
  chart?.dispose()
})
</script>

<template>
  <div ref="root" class="forecast-chart" :aria-label="`${stationName} 的 24 小時庫存趨勢與歷史基線推估圖`" />
</template>
