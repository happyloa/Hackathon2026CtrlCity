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
const riskBadgeTone = computed(() => {
  if (props.station?.serviceStatus !== 'operational') return 'service'
  if (isLive.value && !hasMatchedBaseline.value) return 'inventory'
  return forecast.value?.level || 'normal'
})
const riskLabel = computed(() => {
  const serviceStatus = props.station?.serviceStatus
  if (serviceStatus === 'official_inactive') return '官方未啟用'
  if (serviceStatus === 'suspected_unavailable') return '需人工確認'
  if (isLive.value) {
    const state = props.station?.currentState
    if (state === 'empty_now') return '目前無車'
    if (state === 'full_now') return '目前無位'
    if (forecast.value?.baselineStatus !== 'matched') return '僅即時庫存'
  }
  return ({ normal: '穩定', medium: '觀察', high: '高風險', critical: '立即處理' }[forecast.value?.level || 'normal'])
})

const forecastHeadline = computed(() => {
  if (!isLive.value) return `${props.horizon} 分鐘後`
  if (props.station?.serviceStatus !== 'operational') return '服務狀態待人工確認'
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
  if (props.station?.serviceStatus !== 'operational') return '此狀態不等同已確認停運，請依現場或官方資訊覆核。'
  if (isLive.value && !hasMatchedBaseline.value) return '未對照到唯一歷史站點；系統不假造未來風險。'
  const score = Math.round((forecast.value?.riskScore || 0) * 100)
  const sample = forecast.value?.sampleSize || 0
  const coverage = forecast.value?.baselineCoverage === 'sufficient' ? '歷史樣本充足' : '歷史樣本較少'
  return `風險分數 ${score}／100 · ${coverage}（${sample} 筆）· 需人工覆核`
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
  <div v-if="station" class="station-detail-backdrop" @mousedown.self="closePanel">
  <aside ref="panelRef" class="station-detail" role="dialog" aria-modal="true" aria-labelledby="station-detail-title" tabindex="-1">
    <button type="button" class="close-button" aria-label="關閉站點詳情" @click="closePanel"><Icon icon="solar:close-circle-outline" /></button>
    <div class="detail-topline"><span>{{ isLive ? '即時庫存＋歷史基線' : '站點風險卡' }}</span><span :class="`risk-badge risk-${riskBadgeTone}`">{{ riskLabel }}</span></div>
    <h3 id="station-detail-title">{{ stationName }}</h3>
    <p class="station-location"><Icon icon="solar:map-point-outline" /> {{ station.district || '行政區待確認' }} · {{ station.city }}</p>

    <div class="stock-cells">
      <div><span>可借車</span><strong>{{ station.availableBikes }}</strong></div>
      <div><span>可還位</span><strong>{{ station.availableDocks }}</strong></div>
      <div><span>總車柱</span><strong>{{ station.totalDocks }}</strong></div>
    </div>

    <section v-if="baselineComparison" class="baseline-comparison" aria-label="即時庫存與歷史基線比較">
      <div class="baseline-comparison-heading">
        <span><Icon icon="solar:scale-outline" /> 即時與歷史基線比較</span>
        <small>+{{ horizon }}m · {{ baselineComparison.sampleSize }} 筆樣本</small>
      </div>
      <div class="baseline-comparison-grid">
        <div><span>現在</span><strong>{{ station.availableBikes }} 車／{{ station.availableDocks }} 位</strong></div>
        <div><span>歷史基線</span><strong>{{ baselineComparison.baselineBikes }} 車／{{ baselineComparison.baselineDocks }} 位</strong></div>
        <div><span>{{ horizon }}m 推估</span><strong>{{ baselineComparison.predictedBikes }} 車／{{ baselineComparison.predictedDocks }} 位</strong></div>
      </div>
      <p>{{ baselineComparison.delta }}</p>
    </section>

    <div class="forecast-note">
      <span><Icon :icon="isLive ? 'solar:bolt-circle-outline' : 'solar:chart-2-outline'" /> {{ forecastHeadline }}</span>
      <strong>{{ forecastDescription }}</strong>
      <small>{{ forecastCaption }}</small>
    </div>

    <section v-if="needsReturnGuidance" class="return-guidance" aria-label="附近替代還車站">
      <div class="return-guidance-heading">
        <span><Icon icon="solar:map-point-wave-outline" /> 替代還車站</span>
        <small>600m 內</small>
      </div>
      <p>依現況與 {{ horizon }} 分鐘風險篩選仍保有可還位的站點。</p>
      <div v-if="returnStations.length" class="return-station-list">
        <button v-for="option in returnStations" :key="option.stationId" type="button" @click="emit('select', option.stationId)">
          <span><b>{{ option.name }}</b><small>{{ option.distanceMeters }}m · {{ option.district }}</small></span>
          <strong>{{ option.availableDocks }} 位</strong>
        </button>
      </div>
      <p v-else class="return-guidance-empty">600m 內暫無穩定可還位站點，請改由調度人員處理。</p>
      <small class="return-guidance-footnote">距離為直線估算，實際引導仍須依道路與現場狀態確認。</small>
    </section>

    <DisclosurePanel v-if="!isLive" class="detail-trend" title="最近 6 小時庫存趨勢">
      <div class="detail-chart-wrap">
        <div class="mini-heading"><span>歷史＋基線推估</span><i><b />可借車 <b class="dock-key" />可還位</i></div>
        <ForecastChart :history="history" :station-name="stationName" :capacity="station.totalDocks" :projections="chartProjections" />
      </div>
    </DisclosurePanel>

    <div class="reason-list">
      <p>{{ isLive ? '即時與基線判讀' : '模型判讀依據' }}</p>
      <span v-for="reason in forecast?.reasons" :key="reason"><Icon icon="solar:check-read-outline" /> {{ reason }}</span>
      <span v-for="flag in station.qualityFlags" :key="flag" class="quality-flag"><Icon icon="solar:info-circle-outline" /> {{ flag }}</span>
    </div>
    <NuxtLink v-if="!isLive" :to="detailTarget" class="detail-link">開啟完整站點視圖 <Icon icon="solar:arrow-right-outline" /></NuxtLink>
  </aside>
  </div>
  </Transition>
  </Teleport>
</template>

<style scoped>
.station-detail-backdrop { position: fixed; z-index: 1100; inset: 0; display: flex; justify-content: flex-end; background: rgb(0 0 0 / .48); }
.station-detail { display: block; width: min(480px, 100%); height: 100%; min-height: 0; max-height: 100dvh; padding: 22px; overflow-y: auto; border: 0; border-left: 1px solid var(--line); border-radius: 0; outline: 0; box-shadow: -18px 0 44px rgb(0 0 0 / .16); }
.station-detail .close-button { width: 44px; height: 44px; top: 10px; right: 10px; border-radius: 5px; }
.detail-drawer-enter-active, .detail-drawer-leave-active { transition: opacity .18s ease; }
.detail-drawer-enter-active .station-detail, .detail-drawer-leave-active .station-detail { transition: transform .18s ease; }
.detail-drawer-enter-from, .detail-drawer-leave-to { opacity: 0; }
.detail-drawer-enter-from .station-detail, .detail-drawer-leave-to .station-detail { transform: translateX(100%); }
.baseline-comparison { margin: 0 0 13px; padding: 10px; background: var(--surface-muted); border: 1px solid var(--line); border-left: 3px solid var(--teal-dark); border-radius: 4px; }
.baseline-comparison-heading { display: flex; align-items: center; justify-content: space-between; gap: 8px; color: var(--ink); font-size: 16px; font-weight: 800; }
.baseline-comparison-heading span { display: inline-flex; align-items: center; gap: 5px; }.baseline-comparison-heading svg { color: var(--teal-dark); font-size: 18px; }.baseline-comparison-heading small { color: var(--muted); font-size: 16px; font-weight: 700; }
.baseline-comparison-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 6px; margin-top: 9px; }
.baseline-comparison-grid div { display: grid; gap: 2px; min-width: 0; padding: 7px; background: var(--panel); border: 1px solid var(--line); border-radius: 4px; }
.baseline-comparison-grid span { color: var(--muted); font-size: 16px; font-weight: 700; }.baseline-comparison-grid strong { color: var(--ink); font-family: 'DM Mono', monospace; font-size: 16px; line-height: 1.35; }
.risk-badge.risk-service { color: var(--muted); background: var(--surface-muted); border-color: var(--line-strong); }
.risk-badge.risk-inventory { color: var(--orange); background: var(--surface-muted); border-color: var(--line-strong); }
.baseline-comparison > p { margin: 8px 0 0; color: var(--teal-dark); font-size: 16px; font-weight: 800; line-height: 1.4; }
.return-guidance { margin-top: 12px; padding: 11px; background: var(--surface-muted); border: 1px solid var(--line); border-left: 3px solid var(--blue); border-radius: 4px; }
.return-guidance-heading { display: flex; align-items: center; justify-content: space-between; gap: 8px; color: var(--ink); font-size: 16px; font-weight: 800; }
.return-guidance-heading span { display: inline-flex; align-items: center; gap: 5px; }.return-guidance-heading svg { color: var(--blue); font-size: 18px; }.return-guidance-heading small { color: var(--muted); font-size: 16px; font-weight: 700; }
.return-guidance > p { margin: 6px 0 8px; color: var(--muted); font-size: 16px; line-height: 1.45; }
.return-station-list { display: grid; gap: 5px; }.return-station-list button { display: flex; align-items: center; justify-content: space-between; gap: 9px; width: 100%; padding: 7px 8px; color: var(--ink); background: var(--panel); border: 1px solid var(--line); border-radius: 4px; font: inherit; text-align: left; cursor: pointer; }.return-station-list button:hover, .return-station-list button:focus-visible { border-color: var(--teal-dark); outline: 3px solid rgb(30 111 98 / .3); outline-offset: 2px; }.return-station-list span { display: grid; min-width: 0; gap: 1px; }.return-station-list b { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }.return-station-list small { color: var(--muted); font-size: 16px; }.return-station-list strong { flex: 0 0 auto; color: var(--blue); font-family: 'DM Mono', monospace; font-size: 16px; }
.return-guidance-empty { color: var(--muted); }.return-guidance-footnote { display: block; margin-top: 7px; color: var(--muted); font-size: 16px; line-height: 1.4; }
.detail-trend { margin-top: 12px; border: 1px solid var(--line); border-radius: 4px; }.detail-trend :deep(.disclosure-trigger) { padding: 9px 10px; }.detail-trend .detail-chart-wrap { margin: 12px 10px; }
:global(html[data-theme='dark'] .return-guidance) { border-left-color: var(--blue); }:global(html[data-theme='dark'] .return-station-list button) { color: var(--ink); background: var(--panel); border-color: var(--line); }:global(html[data-theme='dark'] .return-station-list strong) { color: var(--blue); }
@media (max-width: 620px) {
  .station-detail-backdrop { align-items: flex-end; }
  .station-detail { width: 100%; height: auto; max-height: 90dvh; padding: 18px 16px calc(18px + env(safe-area-inset-bottom)); border-top: 1px solid var(--line); border-left: 0; border-radius: 12px 12px 0 0; box-shadow: 0 -18px 44px rgb(0 0 0 / .2); }
  .detail-drawer-enter-from .station-detail, .detail-drawer-leave-to .station-detail { transform: translateY(100%); }
  .baseline-comparison-grid { grid-template-columns: 1fr; }
  .baseline-comparison-heading { align-items: flex-start; flex-direction: column; gap: 2px; }
}

@media (prefers-reduced-motion: reduce) {
  .detail-drawer-enter-active, .detail-drawer-leave-active, .detail-drawer-enter-active .station-detail, .detail-drawer-leave-active .station-detail { transition: none; }
}
</style>
