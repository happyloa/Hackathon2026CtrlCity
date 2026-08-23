<script setup lang="ts">
import type { StationHistoryPoint } from '~/shared/ops'

type ProjectionPoint = {
  label: string
  bikes: number
  docks: number
}

type ChartPoint = ProjectionPoint & {
  index: number
  kind: 'actual' | 'projection'
}

const props = defineProps<{
  history: StationHistoryPoint[]
  stationName: string
  capacity?: number
  projections?: ProjectionPoint[]
}>()

const dimensions = { width: 640, height: 250, top: 18, right: 16, bottom: 37, left: 44 }
const plotWidth = dimensions.width - dimensions.left - dimensions.right
const plotHeight = dimensions.height - dimensions.top - dimensions.bottom

function formatTime(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat('zh-TW', { hour: '2-digit', minute: '2-digit', hour12: false }).format(date)
}

function formatValue(value: number) {
  return Number.isInteger(value) ? String(value) : value.toFixed(1)
}

function linePath(points: Array<{ x: number, y: number }>) {
  return points.map((point, index) => `${index ? 'L' : 'M'} ${point.x} ${point.y}`).join(' ')
}

const chart = computed(() => {
  const history = props.history || []
  const projections = props.projections || []
  const labels = [...history.map(point => formatTime(point.at)), ...projections.map(point => point.label)]
  const values = [...history.flatMap(point => [point.bikes, point.docks]), ...projections.flatMap(point => [point.bikes, point.docks])]
  const configuredCapacity = Number(props.capacity)
  const dataMaximum = Math.max(1, ...values)
  const maximum = Number.isFinite(configuredCapacity) && configuredCapacity > 0
    ? configuredCapacity
    : Math.ceil(dataMaximum / 5) * 5
  const interval = Math.max(1, labels.length - 1)
  const x = (index: number) => dimensions.left + (plotWidth * index / interval)
  const y = (value: number) => dimensions.top + plotHeight - (Math.max(0, Math.min(value, maximum)) / maximum * plotHeight)
  const actual = history.map((point, index): ChartPoint => ({ ...point, label: labels[index] || formatTime(point.at), index, kind: 'actual' }))
  const projected = projections.map((point, index): ChartPoint => ({ ...point, index: history.length + index, kind: 'projection' }))
  const labelStep = Math.max(1, Math.ceil(interval / 4))
  const xLabels = labels
    .map((label, index) => ({ label, index }))
    .filter(({ index }) => index === 0 || index === labels.length - 1 || index % labelStep === 0)
  const yTicks = Array.from({ length: 4 }, (_, index) => {
    const value = maximum * index / 3
    return { value, y: y(value) }
  })
  const projectionStart = actual.at(-1)

  return {
    actual,
    projected,
    x,
    y,
    xLabels,
    yTicks,
    actualBikePath: linePath(actual.map(point => ({ x: x(point.index), y: y(point.bikes) }))),
    actualDockPath: linePath(actual.map(point => ({ x: x(point.index), y: y(point.docks) }))),
    projectedBikePath: linePath([
      ...(projectionStart ? [{ x: x(projectionStart.index), y: y(projectionStart.bikes) }] : []),
      ...projected.map(point => ({ x: x(point.index), y: y(point.bikes) })),
    ]),
    projectedDockPath: linePath([
      ...(projectionStart ? [{ x: x(projectionStart.index), y: y(projectionStart.docks) }] : []),
      ...projected.map(point => ({ x: x(point.index), y: y(point.docks) })),
    ]),
  }
})

const chartDescription = computed(() => {
  const projectionText = chart.value.projected.length ? '；虛線為歷史基線推估' : ''
  return `${props.stationName} 的庫存趨勢。綠線表示可借車，橘線表示可還位，實線為實際資料${projectionText}。`
})
</script>

<template>
  <figure class="flex flex-col gap-1">
    <div class="min-h-0 flex-1 overflow-x-auto">
    <svg
      class="block h-auto min-w-160 w-160"
      :viewBox="`0 0 ${dimensions.width} ${dimensions.height}`"
      preserveAspectRatio="xMidYMid meet"
      role="img"
      :aria-label="`${stationName} 的 6 小時庫存趨勢與歷史基線推估圖`"
    >
      <title>{{ stationName }}庫存趨勢</title>
      <desc>{{ chartDescription }}</desc>

      <g aria-hidden="true">
        <line
          v-for="tick in chart.yTicks"
          :key="`grid-${tick.value}`"
          class="stroke-line"
          :x1="dimensions.left"
          :x2="dimensions.width - dimensions.right"
          :y1="tick.y"
          :y2="tick.y"
          stroke-width="1"
        />
        <text
          v-for="tick in chart.yTicks"
          :key="`y-label-${tick.value}`"
          class="fill-muted text-base"
          :x="dimensions.left - 7"
          :y="tick.y + 4"
          text-anchor="end"
        >{{ formatValue(tick.value) }}</text>
        <line
          class="stroke-line-strong"
          :x1="dimensions.left"
          :x2="dimensions.width - dimensions.right"
          :y1="dimensions.top + plotHeight"
          :y2="dimensions.top + plotHeight"
          stroke-width="1"
        />
        <text
          v-for="item in chart.xLabels"
          :key="`x-label-${item.index}`"
          class="fill-muted text-base"
          :x="chart.x(item.index)"
          :y="dimensions.height - 9"
          text-anchor="middle"
        >{{ item.label }}</text>
      </g>

      <path v-if="chart.actual.length > 1" class="stroke-accent" fill="none" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" :d="chart.actualBikePath" />
      <path v-if="chart.actual.length > 1" class="stroke-warning" fill="none" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" :d="chart.actualDockPath" />
      <path v-if="chart.projected.length" class="stroke-accent" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" stroke-dasharray="6 4" :d="chart.projectedBikePath" />
      <path v-if="chart.projected.length" class="stroke-warning" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" stroke-dasharray="6 4" :d="chart.projectedDockPath" />

      <g v-for="point in chart.actual" :key="`actual-${point.index}`">
        <circle
          class="fill-accent stroke-panel"
          :cx="chart.x(point.index)"
          :cy="chart.y(point.bikes)"
          r="3.2"
          stroke-width="1.5"
        ><title>{{ point.label }}：可借車 {{ point.bikes }} 台</title></circle>
        <circle
          class="fill-warning stroke-panel"
          :cx="chart.x(point.index)"
          :cy="chart.y(point.docks)"
          r="3.2"
          stroke-width="1.5"
        ><title>{{ point.label }}：可還位 {{ point.docks }} 位</title></circle>
      </g>
      <g v-for="point in chart.projected" :key="`projection-${point.index}`">
        <circle
          class="fill-panel stroke-accent"
          :cx="chart.x(point.index)"
          :cy="chart.y(point.bikes)"
          r="4"
          stroke-width="2.3"
        ><title>{{ point.label }} 基線推估：可借車 {{ point.bikes }} 台</title></circle>
        <circle
          class="fill-panel stroke-warning"
          :cx="chart.x(point.index)"
          :cy="chart.y(point.docks)"
          r="4"
          stroke-width="2.3"
        ><title>{{ point.label }} 基線推估：可還位 {{ point.docks }} 位</title></circle>
      </g>
    </svg>
    </div>

    <figcaption class="flex flex-wrap gap-x-3 gap-y-1 text-base leading-5 text-muted">
      <span class="inline-flex items-center gap-1"><i class="inline-block w-3.5 border-t-2 border-accent" />可借車</span>
      <span class="inline-flex items-center gap-1"><i class="inline-block w-3.5 border-t-2 border-warning" />可還位</span>
      <span v-if="chart.projected.length" class="inline-flex items-center gap-1"><i class="inline-block w-3.5 border-t-2 border-dashed border-muted" />基線推估</span>
    </figcaption>
  </figure>
</template>
