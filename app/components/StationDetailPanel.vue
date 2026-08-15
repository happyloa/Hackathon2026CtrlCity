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

const isLive = computed(() => props.dataMode === 'live')
const stationName = computed(() => displayStationName(props.station?.name || ''))
const forecast = computed(() => props.station?.forecast.horizons[props.horizon])
const hasMatchedBaseline = computed(() => forecast.value?.baselineStatus === 'matched')
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
  return `風險指標 ${score}／100 · 歷史樣本 ${sample} 筆 · 需人工覆核`
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
</script>

<template>
  <aside v-if="station" class="station-detail" aria-label="站點詳情">
    <button type="button" class="close-button" aria-label="關閉站點詳情" @click="emit('close')"><Icon icon="solar:close-circle-outline" /></button>
    <div class="detail-topline"><span>{{ isLive ? '即時庫存＋歷史基線' : '站點風險卡' }}</span><span :class="`risk-badge risk-${forecast?.level}`">{{ riskLabel }}</span></div>
    <h3>{{ stationName }}</h3>
    <p class="station-location"><Icon icon="solar:map-point-outline" /> {{ station.district || '行政區待確認' }} · {{ station.city }}</p>

    <div class="stock-cells">
      <div><span>可借車</span><strong>{{ station.availableBikes }}</strong></div>
      <div><span>可還位</span><strong>{{ station.availableDocks }}</strong></div>
      <div><span>總車柱</span><strong>{{ station.totalDocks }}</strong></div>
    </div>

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

    <details v-if="!isLive" class="detail-trend">
      <summary><span>最近 6 小時庫存趨勢</span><Icon icon="solar:alt-arrow-down-outline" /></summary>
      <div class="detail-chart-wrap">
        <div class="mini-heading"><span>歷史＋基線推估</span><i><b />可借車 <b class="dock-key" />可還位</i></div>
        <ForecastChart :history="history" :station-name="stationName" :capacity="station.totalDocks" :projections="chartProjections" />
      </div>
    </details>

    <div class="reason-list">
      <p>{{ isLive ? '即時與基線判讀' : '模型判讀依據' }}</p>
      <span v-for="reason in forecast?.reasons" :key="reason"><Icon icon="solar:check-read-outline" /> {{ reason }}</span>
      <span v-for="flag in station.qualityFlags" :key="flag" class="quality-flag"><Icon icon="solar:info-circle-outline" /> {{ flag }}</span>
    </div>
    <NuxtLink v-if="!isLive" :to="detailTarget" class="detail-link">開啟完整站點視圖 <Icon icon="solar:arrow-right-outline" /></NuxtLink>
  </aside>
</template>

<style scoped>
.return-guidance { margin-top: 12px; padding: 11px; background: var(--surface-muted); border: 1px solid var(--line); border-left: 3px solid var(--blue); border-radius: 4px; }
.return-guidance-heading { display: flex; align-items: center; justify-content: space-between; gap: 8px; color: var(--ink); font-size: 16px; font-weight: 800; }
.return-guidance-heading span { display: inline-flex; align-items: center; gap: 5px; }.return-guidance-heading svg { color: var(--blue); font-size: 18px; }.return-guidance-heading small { color: var(--muted); font-size: 16px; font-weight: 700; }
.return-guidance > p { margin: 6px 0 8px; color: var(--muted); font-size: 16px; line-height: 1.45; }
.return-station-list { display: grid; gap: 5px; }.return-station-list button { display: flex; align-items: center; justify-content: space-between; gap: 9px; width: 100%; padding: 7px 8px; color: var(--ink); background: var(--panel); border: 1px solid var(--line); border-radius: 4px; font: inherit; text-align: left; cursor: pointer; }.return-station-list button:hover, .return-station-list button:focus-visible { border-color: var(--teal-dark); outline: 0; }.return-station-list span { display: grid; min-width: 0; gap: 1px; }.return-station-list b { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }.return-station-list small { color: var(--muted); font-size: 16px; }.return-station-list strong { flex: 0 0 auto; color: var(--blue); font-family: 'DM Mono', monospace; font-size: 16px; }
.return-guidance-empty { color: var(--muted); }.return-guidance-footnote { display: block; margin-top: 7px; color: var(--muted); font-size: 16px; line-height: 1.4; }
.detail-trend { margin-top: 12px; border: 1px solid var(--line); border-radius: 4px; }.detail-trend summary { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 9px 10px; color: var(--ink); cursor: pointer; font-size: 16px; font-weight: 800; list-style: none; }.detail-trend summary::-webkit-details-marker { display: none; }.detail-trend summary svg { color: var(--teal-dark); font-size: 18px; transition: transform 150ms ease; }.detail-trend[open] summary { border-bottom: 1px solid var(--line); }.detail-trend[open] summary svg { transform: rotate(180deg); }.detail-trend .detail-chart-wrap { margin: 12px 10px; }
:global(html[data-theme='dark'] .return-guidance) { border-left-color: var(--blue); }:global(html[data-theme='dark'] .return-station-list button) { color: var(--ink); background: var(--panel); border-color: var(--line); }:global(html[data-theme='dark'] .return-station-list strong) { color: #c3dcf1; }
</style>
