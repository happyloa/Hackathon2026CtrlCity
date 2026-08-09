<script setup lang="ts">
import { Icon } from '@iconify/vue'
import type { DataMode, HorizonKey, StationHistoryPoint, StationRisk } from '~/shared/ops'

const props = defineProps<{
  station: StationRisk | null
  history: StationHistoryPoint[]
  horizon: HorizonKey
  dataMode?: DataMode
  contextQuery?: Record<string, string>
}>()

const emit = defineEmits<{ close: [] }>()

const isLive = computed(() => props.dataMode === 'live')
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
const detailTarget = computed(() => ({
  path: `/stations/${props.station?.id || ''}`,
  query: props.contextQuery || {},
}))
</script>

<template>
  <aside v-if="station" class="station-detail" aria-label="站點詳情">
    <button type="button" class="close-button" aria-label="關閉站點詳情" @click="emit('close')"><Icon icon="solar:close-circle-outline" /></button>
    <div class="detail-topline"><span>{{ isLive ? '即時庫存＋歷史基線' : '站點風險卡' }}</span><span :class="`risk-badge risk-${forecast?.level}`">{{ riskLabel }}</span></div>
    <h3>{{ station.name }}</h3>
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

    <div v-if="!isLive" class="detail-chart-wrap">
      <div class="mini-heading"><span>最近 6 小時＋基線推估</span><i><b />可借車 <b class="dock-key" />可還位</i></div>
      <ForecastChart :history="history" :station-name="station.name" :capacity="station.totalDocks" :projections="chartProjections" />
    </div>

    <div class="reason-list">
      <p>{{ isLive ? '即時與基線判讀' : '模型判讀依據' }}</p>
      <span v-for="reason in forecast?.reasons" :key="reason"><Icon icon="solar:check-read-outline" /> {{ reason }}</span>
      <span v-for="flag in station.qualityFlags" :key="flag" class="quality-flag"><Icon icon="solar:info-circle-outline" /> {{ flag }}</span>
    </div>
    <NuxtLink v-if="!isLive" :to="detailTarget" class="detail-link">開啟完整站點視圖 <Icon icon="solar:arrow-right-outline" /></NuxtLink>
  </aside>
</template>
