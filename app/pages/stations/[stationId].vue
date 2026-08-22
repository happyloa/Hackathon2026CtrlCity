<script setup lang="ts">
import { Icon } from '@iconify/vue'
import { displayStationName, type HorizonKey, type StationHistoryPoint, type StationRisk } from '~/shared/ops'

const route = useRoute()
const replay = useReplayDashboard()
const live = useLiveDashboard()
const stationId = computed(() => String(route.params.stationId))
const mode = computed(() => route.query.mode === 'historical_replay' ? 'historical_replay' : 'live')
const district = computed(() => typeof route.query.district === 'string' ? route.query.district : '')
const requestedAsOf = computed(() => typeof route.query.at === 'string' ? route.query.at : undefined)
useLivePolling(live.refresh, computed(() => mode.value === 'live'))
const horizon: HorizonKey = '60'
const dashboard = computed(() => mode.value === 'live'
  ? live.dashboardForDistrict(district.value)
  : replay.dashboardForDistrict(district.value))
const activePending = computed(() => mode.value === 'live' ? live.pending.value : replay.pending.value)
const activeError = computed(() => mode.value === 'live' ? live.error.value : replay.error.value)
const record = computed<{ station: StationRisk; history: StationHistoryPoint[] } | null>(() => {
  const station = dashboard.value?.stations.find(candidate => candidate.id === stationId.value)
  return station ? { station, history: dashboard.value?.stationHistories[station.id] || [] } : null
})
const forecast = computed(() => record.value?.station.forecast.horizons[horizon])
const stationName = computed(() => displayStationName(record.value?.station.name || ''))
const contextQuery = computed(() => Object.fromEntries(
  ['mode', 'at', 'district']
    .map(key => [key, route.query[key]])
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string' && Boolean(entry[1])),
))
const chartProjections = computed(() => {
  const station = record.value?.station
  if (!station) return []
  return (['30', '60'] as HorizonKey[]).map((item) => {
    const value = station.forecast.horizons[item]
    return { label: `+${item}m`, bikes: value.predictedBikes, docks: value.predictedDocks }
  })
})
const canShowPrediction = computed(() => mode.value !== 'live' || (
  record.value?.station.serviceStatus === 'operational'
  && forecast.value?.baselineStatus === 'matched'
))
const unavailableForecastTitle = computed(() => {
  if (record.value?.station.serviceStatus === 'official_inactive') return '官方標示站點未啟用'
  if (record.value?.station.serviceStatus === 'suspected_unavailable') return '站點服務狀態需人工確認'
  return '尚未匹配歷史基線'
})
const unavailableForecastExplanation = computed(() => {
  if (record.value?.station.serviceStatus !== 'operational') return '目前只呈現官方即時庫存，不產生 60 分鐘風險或數量預估；請依現場或官方資訊覆核。'
  return '目前未對照到唯一的同站歷史資料，因此只呈現官方即時庫存，不推算未來數量。'
})
const stationDescription = computed(() => {
  if (mode.value === 'historical_replay') return '這是歷史回放時點的庫存與風險資料，可用來解釋調度優先順序。'
  if (!canShowPrediction.value) return unavailableForecastExplanation.value
  return '這是最新官方庫存結合同站歷史基線的 60 分鐘風險資料，可用來覆核即時調度優先順序。'
})

function retryDashboard() {
  if (mode.value === 'live') void live.refresh({ manual: true })
  else void replay.loadScenario(requestedAsOf.value)
}

watch([mode, requestedAsOf], ([nextMode, nextAsOf]) => {
  if (nextMode === 'historical_replay') void replay.loadScenario(nextAsOf)
}, { immediate: true })
</script>

<template>
  <div class="subpage station-page">
    <WorkspaceContext :mode="mode" :district="district" :data-time="dashboard?.meta.asOf" :query="contextQuery" />
    <div v-if="activeError && dashboard" class="live-inline-error" role="alert"><Icon icon="solar:danger-triangle-outline" /> {{ activeError }} 目前仍顯示上一筆成功載入的資料。<PageRetryButton :busy="activePending" @retry="retryDashboard" /></div>
    <div v-if="activePending && !record" class="loading-board" role="status" aria-live="polite" aria-busy="true"><Icon icon="svg-spinners:3-dots-fade" />{{ mode === 'live' ? '正在載入即時站況…' : '正在載入站點歷史…' }}</div>
    <section v-else-if="record" class="station-hero panel">
      <div>
        <p class="section-kicker"><Icon icon="solar:map-point-outline" /> {{ record.station.district || '未分類' }} ・ {{ record.station.city }}</p>
        <h2>{{ stationName }}</h2>
        <p>{{ stationDescription }}</p>
      </div>
      <div class="station-hero-stock">
        <span>可借車 <b>{{ record.station.availableBikes }}</b></span>
        <span>可還位 <b>{{ record.station.availableDocks }}</b></span>
      </div>
    </section>
    <div v-if="record" class="station-insight-grid">
      <section v-if="mode === 'historical_replay'" class="panel chart-panel">
        <div class="panel-heading"><div><p class="section-kicker">歷史庫存走勢</p><h2>最近 6 小時＋基線推估</h2></div></div>
        <ForecastChart :history="record.history" :station-name="stationName" :capacity="record.station.totalDocks" :projections="chartProjections" />
      </section>
      <section class="panel forecast-panel">
        <div class="panel-heading"><div><p class="section-kicker">{{ mode === 'live' ? '即時庫存＋歷史基線' : '歷史資料推估' }}</p><h2>{{ mode === 'live' ? '60 分鐘風險細節' : '風險細節' }}</h2></div></div>
        <template v-if="canShowPrediction">
          <div class="forecast-score"><strong>{{ Math.round((forecast?.riskScore || 0) * 100) }}</strong><span>風險指標／100（需人工覆核）</span></div>
          <dl><div><dt>預估可借車</dt><dd>{{ forecast?.predictedBikes }}</dd></div><div><dt>預估可還位</dt><dd>{{ forecast?.predictedDocks }}</dd></div></dl>
        </template>
        <template v-else>
          <div class="forecast-score"><span><b>{{ unavailableForecastTitle }}</b></span><span>{{ unavailableForecastExplanation }}</span></div>
          <dl><div><dt>目前可借車</dt><dd>{{ record.station.availableBikes }}</dd></div><div><dt>目前可還位</dt><dd>{{ record.station.availableDocks }}</dd></div></dl>
        </template>
        <ul><li v-for="reason in forecast?.reasons" :key="reason"><Icon icon="solar:check-read-outline" /> {{ reason }}</li></ul>
      </section>
    </div>
    <div v-else-if="activeError" class="loading-board error-board" role="alert"><Icon icon="solar:danger-triangle-outline" />{{ activeError }}<PageRetryButton :busy="activePending" @retry="retryDashboard" /></div>
    <div v-else-if="dashboard" class="loading-board error-board" role="alert"><Icon icon="solar:map-point-remove-outline" />目前資料中找不到這個站點。<NuxtLink :to="{ path: '/', query: contextQuery }">返回營運總覽</NuxtLink></div>
  </div>
</template>
