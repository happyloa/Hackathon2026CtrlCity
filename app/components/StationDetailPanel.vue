<script setup lang="ts">
import { Icon } from '@iconify/vue'
import { nearbyReturnStations } from '~/shared/nearby-stations'
import { displayStationName, type DataMode, type HorizonKey, type StationHistoryPoint, type StationRisk } from '~/shared/ops'

const props = defineProps<{
  station: StationRisk | null
  stations: StationRisk[]
  history: StationHistoryPoint[]
  horizon: HorizonKey
  dataMode?: DataMode
  contextQuery?: Record<string, string>
}>()

const emit = defineEmits<{ close: []; select: [stationId: string] }>()

const panelRef = ref<HTMLElement | null>(null)
let previousBodyOverflow = ''
let returnFocusElement: HTMLElement | null = null

const isLive = computed(() => props.dataMode === 'live')
const stationName = computed(() => displayStationName(props.station?.name || ''))
const forecast = computed(() => props.station?.forecast.horizons[props.horizon])
const hasMatchedBaseline = computed(() => forecast.value?.baselineStatus === 'matched')
const riskLabel = computed(() => {
  const serviceStatus = props.station?.serviceStatus
  if (serviceStatus === 'official_inactive') return '官方標示停用'
  if (serviceStatus === 'suspected_unavailable') return '疑似異常'
  if (isLive.value) {
    const state = props.station?.currentState
    if (state === 'empty_now') return '目前無車'
    if (state === 'full_now') return '目前無位'
    if (forecast.value?.baselineStatus !== 'matched') return '僅即時庫存'
  }
  return ({ normal: '穩定', medium: '留意', high: '高風險', critical: '高度風險' }[forecast.value?.level || 'normal'])
})

const riskBadgeClass = computed(() => {
  if (props.station?.serviceStatus !== 'operational') {
    return 'inline-flex rounded-full border border-line-strong bg-panel-muted px-2 py-0.5 text-base font-bold text-muted'
  }
  if (isLive.value && !hasMatchedBaseline.value) {
    return 'inline-flex rounded-full border border-warning bg-warning-surface px-2 py-0.5 text-base font-bold text-warning'
  }
  if (forecast.value?.level === 'critical') {
    return 'inline-flex rounded-full border border-danger bg-danger-surface px-2 py-0.5 text-base font-bold text-danger'
  }
  if (forecast.value?.level === 'high' || forecast.value?.level === 'medium') {
    return 'inline-flex rounded-full border border-warning bg-warning-surface px-2 py-0.5 text-base font-bold text-warning'
  }
  return 'inline-flex rounded-full border border-positive bg-positive-surface px-2 py-0.5 text-base font-bold text-positive'
})

const forecastHeadline = computed(() => {
  if (!isLive.value) return `${props.horizon} 分鐘後`
  if (props.station?.serviceStatus === 'official_inactive') return '官方標示停用，不納入調度'
  if (props.station?.serviceStatus !== 'operational') return '服務狀態異常'
  if (!hasMatchedBaseline.value) return '未對照歷史基線'
  return `${props.horizon} 分鐘歷史基線推估`
})

const forecastDescription = computed(() => {
  if (!isLive.value) return `預測 ${forecast.value?.predictedBikes} 車／${forecast.value?.predictedDocks} 位`
  if (props.station?.serviceStatus !== 'operational') return `現況 ${props.station?.availableBikes} 車／${props.station?.availableDocks} 位`
  if (!hasMatchedBaseline.value) return `現況 ${props.station?.availableBikes} 車／${props.station?.availableDocks} 位`
  return `推估 ${forecast.value?.predictedBikes} 車／${forecast.value?.predictedDocks} 位`
})

const forecastCaption = computed(() => {
  if (props.station?.serviceStatus === 'official_inactive') {
    return '官方標示停用，不納入預測與路線。'
  }
  if (props.station?.serviceStatus !== 'operational') return '請查看官方公告或現場狀態。'
  if (isLive.value && !hasMatchedBaseline.value) return '找不到可用的歷史資料，目前只顯示即時庫存。'
  const score = Math.round((forecast.value?.riskScore || 0) * 100)
  const sample = forecast.value?.sampleSize || 0
  const coverage = forecast.value?.baselineCoverage === 'sufficient' ? '歷史樣本充足' : '歷史樣本較少'
  return `風險 ${score}／100 · ${coverage} · ${sample} 筆樣本`
})

const baselineComparison = computed(() => {
  const value = forecast.value
  if (!isLive.value || !hasMatchedBaseline.value || !value || value.baselineBikes === null || value.baselineDocks === null) return null

  const differences = [
    { label: '可借車', value: value.predictedBikes - value.baselineBikes, unit: '台' },
    { label: '可還位', value: value.predictedDocks - value.baselineDocks, unit: '位' },
  ]
    .filter(item => item.value !== 0)
    .sort((left, right) => Math.abs(right.value) - Math.abs(left.value))

  const primary = differences[0]
  const delta = primary
    ? `${props.horizon} 分鐘推估${primary.value < 0 ? '低於' : '高於'}歷史基線 ${Math.abs(primary.value)} ${primary.unit}。`
    : `${props.horizon} 分鐘推估與歷史基線接近。`

  return {
    baselineBikes: value.baselineBikes,
    baselineDocks: value.baselineDocks,
    predictedBikes: value.predictedBikes,
    predictedDocks: value.predictedDocks,
    sampleSize: value.sampleSize,
    score: Math.round(value.riskScore * 100),
    delta,
  }
})

const chartProjections = computed(() => {
  const station = props.station
  if (!station) return []
  return (['30', '60'] as HorizonKey[]).map((item) => {
    const value = station.forecast.horizons[item]
    return { label: `+${item}m`, bikes: value.predictedBikes, docks: value.predictedDocks }
  })
})
const needsReturnGuidance = computed(() => {
  const station = props.station
  const stationForecast = forecast.value
  return station?.serviceStatus === 'operational'
    && Boolean(stationForecast)
    && (station.currentState === 'full_now' || (stationForecast?.fullRisk || 0) >= (stationForecast?.alertThreshold || 1))
})
const returnStations = computed(() => {
  const station = props.station
  return station ? nearbyReturnStations(station, props.stations, props.horizon) : []
})
const detailTarget = computed(() => ({
  path: `/stations/${props.station?.id || ''}`,
  query: props.contextQuery || {},
}))

function closePanel() {
  emit('close')
}

function onPanelKeydown(event: KeyboardEvent) {
  if (!props.station) return
  if (event.key === 'Escape') {
    event.preventDefault()
    closePanel()
    return
  }
  if (event.key !== 'Tab') return

  const focusable = Array.from(panelRef.value?.querySelectorAll<HTMLElement>('button:not([disabled]), [href], input:not([disabled])') || [])
  const first = focusable.at(0)
  const last = focusable.at(-1)
  if (!first || !last) return
  if (event.shiftKey && (document.activeElement === first || document.activeElement === panelRef.value)) {
    event.preventDefault()
    last.focus()
  } else if (!event.shiftKey && (document.activeElement === last || document.activeElement === panelRef.value)) {
    event.preventDefault()
    first.focus()
  }
}

watch(() => props.station?.id, (stationId, previousId) => {
  if (!import.meta.client) return
  if (stationId && !previousId) {
    returnFocusElement = document.activeElement instanceof HTMLElement ? document.activeElement : null
    previousBodyOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
  }
  if (stationId) void nextTick(() => panelRef.value?.focus())
  if (!stationId && previousId) {
    document.body.style.overflow = previousBodyOverflow
    void nextTick(() => returnFocusElement?.focus())
  }
})

onMounted(() => document.addEventListener('keydown', onPanelKeydown))
onBeforeUnmount(() => {
  document.removeEventListener('keydown', onPanelKeydown)
  if (import.meta.client) document.body.style.overflow = previousBodyOverflow
})
</script>

<template>
  <Teleport to="body">
  <Transition name="detail-drawer">
  <div v-if="station" class="fixed inset-0 z-50 flex min-h-0 items-end justify-end bg-black/50 p-3 sm:items-stretch sm:p-0" @mousedown.self="closePanel">
  <aside ref="panelRef" class="station-detail max-h-full w-full overflow-y-auto rounded-xl border border-line bg-panel p-4 pb-6 text-ink shadow-2xl outline-none sm:h-svh sm:max-w-lg sm:rounded-none sm:border-y-0 sm:border-r-0 sm:p-5" role="dialog" aria-modal="true" aria-labelledby="station-detail-title" tabindex="-1">
    <button type="button" class="mb-3 grid h-11 w-11 place-items-center rounded-md border border-line bg-panel-muted p-0 text-ink transition-colors hover:border-accent-strong hover:bg-accent-strong hover:text-on-accent" aria-label="關閉站點詳情" @click="closePanel"><Icon class="text-2xl" icon="solar:close-circle-outline" /></button>
    <div class="flex flex-wrap items-center justify-between gap-2 text-base font-bold text-muted"><span>{{ isLive ? '即時站況' : '歷史站況' }}</span><span :class="riskBadgeClass">{{ riskLabel }}</span></div>
    <h3 id="station-detail-title" class="mt-2 text-2xl font-bold tracking-tight text-ink">{{ stationName }}</h3>
    <p class="mt-1 flex items-center gap-1 text-base text-muted"><Icon class="shrink-0 text-lg text-accent-strong" icon="solar:map-point-outline" /> {{ station.district || '行政區未提供' }} · {{ station.city }}</p>

    <div class="mt-4 grid grid-cols-3 gap-2">
      <div class="grid gap-0.5 rounded-md border border-line bg-panel-muted p-2"><span class="text-base font-bold text-muted">可借車</span><strong class="font-mono text-xl text-ink">{{ station.availableBikes }}</strong></div>
      <div class="grid gap-0.5 rounded-md border border-line bg-panel-muted p-2"><span class="text-base font-bold text-muted">可還位</span><strong class="font-mono text-xl text-ink">{{ station.availableDocks }}</strong></div>
      <div class="grid gap-0.5 rounded-md border border-line bg-panel-muted p-2"><span class="text-base font-bold text-muted">總車柱</span><strong class="font-mono text-xl text-ink">{{ station.totalDocks }}</strong></div>
    </div>

    <section v-if="baselineComparison" class="mb-3 mt-4 rounded-md border border-line border-l-4 border-l-accent-strong bg-panel-muted p-3" aria-label="即時庫存與歷史基線比較">
      <div class="flex flex-col items-start gap-0.5 text-base font-extrabold text-ink sm:flex-row sm:items-center sm:justify-between sm:gap-2">
        <span class="inline-flex items-center gap-1.5"><Icon class="text-lg text-accent-strong" icon="solar:scale-outline" /> {{ horizon }} 分鐘預估</span>
        <small class="text-base font-bold text-muted">風險 {{ baselineComparison.score }}／100 · {{ baselineComparison.sampleSize }} 筆</small>
      </div>
      <div class="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-3">
        <div class="grid min-w-0 gap-0.5 rounded-md border border-line bg-panel p-2"><span class="text-base font-bold text-muted">現在</span><strong class="font-mono text-base leading-5 text-ink">{{ station.availableBikes }} 車／{{ station.availableDocks }} 位</strong></div>
        <div class="grid min-w-0 gap-0.5 rounded-md border border-line bg-panel p-2"><span class="text-base font-bold text-muted">歷史基線</span><strong class="font-mono text-base leading-5 text-ink">{{ baselineComparison.baselineBikes }} 車／{{ baselineComparison.baselineDocks }} 位</strong></div>
        <div class="grid min-w-0 gap-0.5 rounded-md border border-line bg-panel p-2"><span class="text-base font-bold text-muted">{{ horizon }} 分鐘</span><strong class="font-mono text-base leading-5 text-ink">{{ baselineComparison.predictedBikes }} 車／{{ baselineComparison.predictedDocks }} 位</strong></div>
      </div>
      <p class="mt-2 text-base font-extrabold leading-6 text-accent-strong">{{ baselineComparison.delta }}</p>
    </section>

    <div v-if="!baselineComparison" class="mt-4 grid gap-1 rounded-md border border-line bg-panel-muted p-3">
      <span class="inline-flex items-center gap-1.5 text-base font-extrabold text-accent-strong"><Icon class="text-lg" :icon="isLive ? 'solar:bolt-circle-outline' : 'solar:chart-2-outline'" /> {{ forecastHeadline }}</span>
      <strong class="text-lg text-ink">{{ forecastDescription }}</strong>
      <small class="text-base leading-6 text-muted">{{ forecastCaption }}</small>
    </div>

    <section v-if="needsReturnGuidance" class="mt-3 rounded-md border border-line border-l-4 border-l-info bg-panel-muted p-3" aria-label="附近替代還車站">
      <div class="flex items-center justify-between gap-2 text-base font-extrabold text-ink">
        <span class="inline-flex items-center gap-1.5"><Icon class="text-lg text-info" icon="solar:map-point-wave-outline" /> 替代還車站</span>
        <small class="text-base font-bold text-muted">600m 內</small>
      </div>
      <div v-if="returnStations.length" class="mt-2 grid gap-1.5">
        <button v-for="option in returnStations" :key="option.stationId" class="flex w-full items-center justify-between gap-2 rounded-md border border-line bg-panel px-2 py-2 text-left text-base text-ink transition-colors hover:border-accent-strong hover:bg-surface" type="button" @click="emit('select', option.stationId)">
          <span class="grid min-w-0 gap-0.5"><b class="truncate">{{ option.name }}</b><small class="text-base text-muted">{{ option.distanceMeters }}m · {{ option.district }}</small></span>
          <strong class="shrink-0 font-mono text-base text-info">{{ option.availableDocks }} 位</strong>
        </button>
      </div>
      <p v-else class="mt-2 text-base text-muted">600m 內沒有合適的替代站。</p>
    </section>

    <DisclosurePanel v-if="!isLive" class="mt-3 rounded-md border border-line" title="最近 6 小時庫存趨勢">
      <div class="m-3">
        <div class="flex flex-wrap items-center justify-between gap-2 text-base font-bold text-muted"><span>歷史＋基線推估</span><i class="inline-flex items-center gap-1.5 not-italic"><b class="h-2.5 w-2.5 rounded-full bg-accent" />可借車 <b class="ml-1 h-2.5 w-2.5 rounded-full bg-warning" />可還位</i></div>
        <ForecastChart :history="history" :station-name="stationName" :capacity="station.totalDocks" :projections="chartProjections" />
      </div>
    </DisclosurePanel>

    <DisclosurePanel v-if="forecast?.reasons.length || station.qualityFlags.length" class="mt-3 rounded-md border border-line" title="判斷依據">
      <div class="grid gap-2 p-3">
        <span v-for="reason in forecast?.reasons" :key="reason" class="flex items-start gap-1.5 text-base leading-6 text-muted"><Icon class="mt-0.5 shrink-0 text-lg text-accent-strong" icon="solar:check-read-outline" /> {{ reason }}</span>
        <span v-for="flag in station.qualityFlags" :key="flag" class="flex items-start gap-1.5 text-base leading-6 text-warning"><Icon class="mt-0.5 shrink-0 text-lg" icon="solar:info-circle-outline" /> {{ flag }}</span>
      </div>
    </DisclosurePanel>
    <NuxtLink v-if="!isLive" :to="detailTarget" class="mt-4 inline-flex items-center gap-1 text-base font-bold text-accent transition-colors hover:text-accent-strong">開啟完整站點視圖 <Icon class="text-lg" icon="solar:arrow-right-outline" /></NuxtLink>
  </aside>
  </div>
  </Transition>
  </Teleport>
</template>

<style scoped>
.detail-drawer-enter-active .station-detail,
.detail-drawer-leave-active .station-detail { transition: transform 160ms ease; }

.detail-drawer-enter-from .station-detail,
.detail-drawer-leave-to .station-detail { transform: translateX(100%); }

@media (max-width: 639px) {
  .detail-drawer-enter-from .station-detail,
  .detail-drawer-leave-to .station-detail { transform: translateY(100%); }
}
</style>
