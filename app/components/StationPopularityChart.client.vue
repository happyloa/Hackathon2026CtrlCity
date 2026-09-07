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

const dimensions = { width: 720, height: 260, left: 42, right: 12, top: 18, bottom: 36 }
const plotWidth = dimensions.width - dimensions.left - dimensions.right
const plotHeight = dimensions.height - dimensions.top - dimensions.bottom

/**
 * Catmull-Rom to cubic-Bezier conversion (uniform, no tension term) -- gives
 * a smooth curve through every hourly point without overshooting past the
 * neighbouring points, unlike a naive spline.
 */
function smoothPath(points: Array<{ x: number, y: number }>) {
  if (points.length < 2) return ''
  const first = points[0]!
  let path = `M ${first.x} ${first.y}`
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[i - 1] ?? points[i]!
    const p1 = points[i]!
    const p2 = points[i + 1]!
    const p3 = points[i + 2] ?? p2
    const c1x = p1.x + (p2.x - p0.x) / 6
    const c1y = p1.y + (p2.y - p0.y) / 6
    const c2x = p2.x - (p3.x - p1.x) / 6
    const c2y = p2.y - (p3.y - p1.y) / 6
    path += ` C ${c1x} ${c1y}, ${c2x} ${c2y}, ${p2.x} ${p2.y}`
  }
  return path
}

const chart = computed(() => {
  const maximum = Math.max(1, props.station.totalDocks, ...hours.value.flatMap(item => [item.meanAvailableBikes, item.meanAvailableDocks]))
  const x = (hour: number) => dimensions.left + (plotWidth * hour / 23)
  const y = (value: number) => dimensions.top + plotHeight - (Math.max(0, Math.min(value, maximum)) / maximum * plotHeight)
  const points = Array.from({ length: 24 }, (_, hour) => {
    const value = hours.value[hour] || { hour, sampleDays: 0, meanAvailableBikes: 0, meanAvailableDocks: 0 }
    return { ...value, x: x(hour), borrowY: y(value.meanAvailableDocks), returnY: y(value.meanAvailableBikes) }
  })
  const yTicks = Array.from({ length: 4 }, (_, index) => {
    const value = maximum * index / 3
    return { value, y: y(value) }
  })
  return {
    maximum,
    points,
    yTicks,
    borrowPath: smoothPath(points.map(point => ({ x: point.x, y: point.borrowY }))),
    returnPath: smoothPath(points.map(point => ({ x: point.x, y: point.returnY }))),
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
  <DisclosurePanel class="mt-4 rounded-md border border-line" title="借還車熱門度">
    <div class="p-3">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <span class="group relative inline-flex" tabindex="0">
          <Icon class="text-lg text-muted" icon="solar:question-circle-outline" aria-label="熱門度說明" />
          <span
            class="pointer-events-none absolute left-1/2 top-full z-10 mt-1 hidden w-64 -translate-x-1/2 rounded-md border border-line-strong bg-panel p-2 text-sm font-medium leading-5 text-muted shadow-lg group-hover:block group-focus:block">依歷史平均庫存比例呈現：可還位越多代表借車越熱門，可借車越多代表還車越熱門。平均值只採用常態分布
            μ±1σ 範圍內的中央約 68% 觀測。</span>
        </span>
        <label class="inline-flex items-center gap-2 text-base font-bold text-muted">
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
      <figure v-else class="mt-2 flex flex-col gap-1">
        <svg class="block h-auto w-full" :viewBox="`0 0 ${dimensions.width} ${dimensions.height}`" role="img"
          :aria-label="`${station.name}星期熱門借還車時段圖`">
          <title>{{ station.name }}借還車熱門度</title>
          <desc>藍線以歷史平均可還位表示借車熱門度，橘線以歷史平均可借車表示還車熱門度，並以總車柱數作為共同尺度。</desc>

          <g aria-hidden="true">
            <line v-for="tick in chart.yTicks" :key="`grid-${tick.value}`" class="stroke-line" :x1="dimensions.left"
              :x2="dimensions.width - dimensions.right" :y1="tick.y" :y2="tick.y" stroke-width="1" />
            <text v-for="tick in chart.yTicks" :key="`y-label-${tick.value}`" class="fill-muted text-base"
              :x="dimensions.left - 7" :y="tick.y + 4" text-anchor="end">{{ formatEstimate(tick.value) }}</text>
            <line class="stroke-line-strong" :x1="dimensions.left" :x2="dimensions.width - dimensions.right"
              :y1="dimensions.top + plotHeight" :y2="dimensions.top + plotHeight" stroke-width="1" />
            <template v-for="point in chart.points" :key="`x-label-${point.hour}`">
              <text v-if="point.hour % 3 === 0" class="fill-muted text-base" :x="point.x"
                :y="dimensions.height - 12" text-anchor="middle">{{ point.hour }}時</text>
            </template>
          </g>

          <path class="stroke-info" fill="none" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" :d="chart.borrowPath" />
          <path class="stroke-warning" fill="none" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" :d="chart.returnPath" />

          <g v-for="point in chart.points" :key="`points-${point.hour}`">
            <circle class="fill-info stroke-panel" :cx="point.x" :cy="point.borrowY" r="3.2" stroke-width="1.5">
              <title>{{ point.hour }}–{{ point.hour + 1 }} 時：借車熱門度 {{ formatEstimate(point.meanAvailableDocks) }}／{{
                chart.maximum
                }}（平均可借 {{ formatEstimate(point.meanAvailableBikes) }} 車、可還 {{ formatEstimate(point.meanAvailableDocks) }}
                位；{{
                  point.sampleDays }} 天樣本）</title>
            </circle>
            <circle class="fill-warning stroke-panel" :cx="point.x" :cy="point.returnY" r="3.2" stroke-width="1.5">
              <title>{{ point.hour }}–{{ point.hour + 1 }} 時：還車熱門度 {{ formatEstimate(point.meanAvailableBikes) }}／{{
                chart.maximum
                }}（平均可借 {{ formatEstimate(point.meanAvailableBikes) }} 車、可還 {{ formatEstimate(point.meanAvailableDocks) }}
                位；{{
                  point.sampleDays }} 天樣本）</title>
            </circle>
          </g>
        </svg>
        <figcaption class="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-sm leading-5 text-muted">
          <span class="flex flex-wrap gap-x-3 gap-y-1">
            <span class="inline-flex items-center gap-1"><i class="inline-block w-3.5 border-t-2 border-info" />借車熱門度</span>
            <span class="inline-flex items-center gap-1"><i class="inline-block w-3.5 border-t-2 border-warning" />還車熱門度</span>
          </span>
          <span>共同尺度 {{ chart.maximum }} 格 · 最多 {{ chart.sampleDays }} 天樣本</span>
        </figcaption>
      </figure>
    </div>
  </DisclosurePanel>
</template>
