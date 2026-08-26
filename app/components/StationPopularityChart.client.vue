<script setup lang="ts">
import { Icon } from '@iconify/vue'
import { stationPopularityFor } from '~/composables/useStationPopularity'
import type { StationRisk } from '~/shared/ops'
import { taipeiWeekday, type StationPopularityHour } from '~/shared/station-popularity'

const props = defineProps<{ station: StationRisk }>()

const weekdays = [
  { value: 1, label: '星期一' },
  { value: 2, label: '星期二' },
  { value: 3, label: '星期三' },
  { value: 4, label: '星期四' },
  { value: 5, label: '星期五' },
  { value: 6, label: '星期六' },
  { value: 0, label: '星期日' },
]
const selectedWeekday = ref(taipeiWeekday())
const hours = ref<StationPopularityHour[]>([])
const pending = ref(false)
const error = ref('')
let latestRequest = 0

const dimensions = { width: 720, height: 280, left: 42, right: 12, top: 24, center: 132, bottom: 238 }
const plotWidth = dimensions.width - dimensions.left - dimensions.right
const halfPlotHeight = Math.min(dimensions.center - dimensions.top, dimensions.bottom - dimensions.center) - 8
const columnWidth = plotWidth / 24
const barWidth = Math.max(5, columnWidth - 4)

const chart = computed(() => {
  const maximum = Math.max(1, props.station.totalDocks, ...hours.value.flatMap(item => [item.meanAvailableBikes, item.meanAvailableDocks]))
  const height = (value: number) => Math.max(0, Math.min(halfPlotHeight, value / maximum * halfPlotHeight))
  const points = Array.from({ length: 24 }, (_, hour) => {
    const value = hours.value[hour] || { hour, sampleDays: 0, meanAvailableBikes: 0, meanAvailableDocks: 0 }
    const pickupHeight = height(value.meanAvailableDocks)
    const returnHeight = height(value.meanAvailableBikes)
    return {
      ...value,
      x: dimensions.left + hour * columnWidth + (columnWidth - barWidth) / 2,
      centerX: dimensions.left + (hour + .5) * columnWidth,
      pickupHeight,
      pickupY: dimensions.center - pickupHeight,
      returnHeight,
    }
  })
  return {
    maximum,
    points,
    sampleDays: Math.max(0, ...points.map(point => point.sampleDays)),
    hasData: points.some(point => point.sampleDays > 0),
  }
})

function formatEstimate(value: number) {
  return Number.isInteger(value) ? String(value) : value.toFixed(1)
}

async function loadPopularity() {
  const requestId = ++latestRequest
  pending.value = true
  error.value = ''
  try {
    const result = await stationPopularityFor(props.station, selectedWeekday.value)
    if (requestId === latestRequest) hours.value = result
  } catch {
    if (requestId === latestRequest) {
      hours.value = []
      error.value = '熱門度統計暫時無法載入。'
    }
  } finally {
    if (requestId === latestRequest) pending.value = false
  }
}

watch([() => props.station.id, selectedWeekday], () => { void loadPopularity() }, { immediate: true })
</script>

<template>
  <section class="mt-4 rounded-md border border-line bg-panel-muted p-3" aria-labelledby="station-popularity-title">
    <div class="flex flex-wrap items-center justify-between gap-2">
      <div class="flex items-center gap-2">
        <h4 id="station-popularity-title" class="inline-flex items-center gap-1.5 text-base font-extrabold text-ink">
          <Icon class="text-lg text-accent-strong" icon="solar:chart-square-outline" />借還車熱門度
        </h4>
        <span class="group relative inline-flex" tabindex="0">
          <Icon class="text-lg text-muted" icon="solar:question-circle-outline" aria-label="熱門度說明" />
          <span
            class="pointer-events-none absolute left-1/2 top-full z-10 mt-1 hidden w-64 -translate-x-1/2 rounded-md border border-line-strong bg-panel p-2 text-sm font-medium leading-5 text-muted shadow-lg group-hover:block group-focus:block">依歷史平均庫存比例呈現：可還位越多代表借車越熱門，可借車越多代表還車越熱門。平均值只採用常態分布
            μ±1σ 範圍內的中央約 68% 觀測。</span>
        </span>
      </div>
      <label class="inline-flex items-center gap-2 text-base font-bold text-muted">
        <!-- <span>星期</span> -->
        <select v-model.number="selectedWeekday"
          class="min-h-10 rounded-md border border-line-strong bg-panel px-2.5 py-1.5 font-bold text-ink outline-none focus:border-accent-strong"
          aria-label="選擇熱門度星期">
          <option v-for="weekday in weekdays" :key="weekday.value" :value="weekday.value">{{ weekday.label }}</option>
        </select>
      </label>
    </div>

    <div v-if="pending" class="grid min-h-48 place-items-center text-base font-bold text-muted" role="status">正在載入熱門度統計…
    </div>
    <div v-else-if="error" class="grid min-h-32 place-items-center text-center text-base font-bold text-warning"
      role="status">{{ error }}</div>
    <div v-else-if="!chart.hasData" class="grid min-h-32 place-items-center text-center text-base font-bold text-muted">
      此站在所選星期沒有足夠的歷史樣本。</div>
    <figure v-else class="mt-2">
      <svg class="block h-auto w-full" :viewBox="`0 0 ${dimensions.width} ${dimensions.height}`" role="img"
        :aria-label="`${station.name}星期熱門借還車時段圖`">
        <title>{{ station.name }}借還車熱門度</title>
        <desc>中線以上以歷史平均可還位表示借車熱門度，中線以下以歷史平均可借車表示還車熱門度，並以總車柱數作為共同尺度。</desc>

        <g aria-hidden="true">
          <line class="stroke-line-strong" :x1="dimensions.left" :x2="dimensions.width - dimensions.right"
            :y1="dimensions.center" :y2="dimensions.center" stroke-width="1.5" />
          <text class="fill-info text-base font-bold" x="4" :y="dimensions.center - 12">借車</text>
          <text class="fill-warning text-base font-bold" x="4" :y="dimensions.center + 23">還車</text>
          <template v-for="point in chart.points" :key="`axis-${point.hour}`">
            <line v-if="point.hour % 3 === 0" class="stroke-line" :x1="point.centerX" :x2="point.centerX"
              :y1="dimensions.center - 3" :y2="dimensions.center + 3" stroke-width="1" />
            <text v-if="point.hour % 3 === 0" class="fill-muted text-base" :x="point.centerX"
              :y="dimensions.height - 12" text-anchor="middle">{{ point.hour }}時</text>
          </template>
        </g>

        <g v-for="point in chart.points" :key="`bars-${point.hour}`">
          <rect class="fill-info" :x="point.x" :y="point.pickupY" :width="barWidth" :height="point.pickupHeight" rx="2">
            <title>{{ point.hour }}–{{ point.hour + 1 }} 時：借車熱門度 {{ formatEstimate(point.meanAvailableDocks) }}／{{
              chart.maximum
              }}（平均可借 {{ formatEstimate(point.meanAvailableBikes) }} 車、可還 {{ formatEstimate(point.meanAvailableDocks) }}
              位；{{
                point.sampleDays }} 天樣本）</title>
          </rect>
          <rect class="fill-warning" :x="point.x" :y="dimensions.center" :width="barWidth" :height="point.returnHeight"
            rx="2">
            <title>{{ point.hour }}–{{ point.hour + 1 }} 時：還車熱門度 {{ formatEstimate(point.meanAvailableBikes) }}／{{
              chart.maximum
              }}（平均可借 {{ formatEstimate(point.meanAvailableBikes) }} 車、可還 {{ formatEstimate(point.meanAvailableDocks) }}
              位；{{
                point.sampleDays }} 天樣本）</title>
          </rect>
        </g>
      </svg>
      <figcaption class="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-sm leading-5 text-muted">
        <span>中央約 68% 歷史庫存平均 · 共同尺度 {{ chart.maximum }} 格</span>
        <span>最多 {{ chart.sampleDays }} 天樣本</span>
      </figcaption>
    </figure>
  </section>
</template>
