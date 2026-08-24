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
  if (record.value?.station.serviceStatus === 'suspected_unavailable') return '服務狀態異常'
  return '找不到歷史資料'
})
const unavailableForecastExplanation = computed(() => {
  if (record.value?.station.serviceStatus !== 'operational') return '目前只顯示官方即時庫存，不做 60 分鐘預估。'
  return '找不到可用的同站歷史資料，目前只顯示即時庫存。'
})
const stationDescription = computed(() => {
  if (mode.value === 'historical_replay') return '查看這個歷史時點的庫存與風險。'
  if (!canShowPrediction.value) return unavailableForecastExplanation.value
  return '最新官方庫存與未來 60 分鐘站況。'
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
  <div class="mx-auto w-full max-w-screen-2xl space-y-4 px-4 py-4 sm:px-6 lg:px-8 lg:py-6">
    <WorkspaceContext :mode="mode" :district="district" :data-time="dashboard?.meta.asOf" :query="contextQuery" />
    <div v-if="activeError && dashboard" class="live-inline-error text-base" role="alert"><Icon icon="solar:danger-triangle-outline" /> {{ activeError }} 目前仍顯示上一筆成功載入的資料。<PageRetryButton :busy="activePending" @retry="retryDashboard" /></div>
    <div v-if="activePending && !record" class="loading-board" role="status" aria-live="polite" aria-busy="true"><Icon icon="svg-spinners:3-dots-fade" />{{ mode === 'live' ? '正在載入即時站況…' : '正在載入站點歷史…' }}</div>
    <section v-else-if="record" class="panel flex flex-col gap-4 p-4 sm:p-5 lg:flex-row lg:items-center lg:justify-between">
      <div class="min-w-0">
        <p class="section-kicker text-base"><Icon icon="solar:map-point-outline" /> {{ record.station.district || '未分類' }} ・ {{ record.station.city }}</p>
        <h2 class="mt-2 text-2xl font-bold tracking-tight">{{ stationName }}</h2>
        <p class="mt-2 max-w-3xl text-base leading-7 text-muted">{{ stationDescription }}</p>
      </div>
      <div class="grid shrink-0 grid-cols-2 gap-2">
        <span class="flex min-h-16 flex-col justify-center rounded-lg bg-surface px-3 text-base font-semibold text-muted">可借車 <b class="mt-1 text-xl text-ink">{{ record.station.availableBikes }}</b></span>
        <span class="flex min-h-16 flex-col justify-center rounded-lg bg-surface px-3 text-base font-semibold text-muted">可還位 <b class="mt-1 text-xl text-ink">{{ record.station.availableDocks }}</b></span>
      </div>
    </section>
    <div v-if="record" class="grid grid-cols-1 gap-4 xl:grid-cols-2">
      <section v-if="mode === 'historical_replay'" class="panel overflow-hidden">
        <div class="border-b border-line px-4 py-4 sm:px-5"><p class="section-kicker text-base">歷史庫存走勢</p><h2 class="mt-2 text-xl font-bold tracking-tight">最近 6 小時＋基線推估</h2></div>
        <ForecastChart :history="record.history" :station-name="stationName" :capacity="record.station.totalDocks" :projections="chartProjections" />
      </section>
      <section class="panel overflow-hidden">
        <div class="border-b border-line px-4 py-4 sm:px-5"><p class="section-kicker text-base">{{ mode === 'live' ? '即時預估' : '歷史預估' }}</p><h2 class="mt-2 text-xl font-bold tracking-tight">{{ mode === 'live' ? '60 分鐘站況' : '風險細節' }}</h2></div>
        <template v-if="canShowPrediction">
          <div class="mx-4 mt-4 flex flex-wrap items-end gap-x-3 gap-y-1 rounded-lg bg-warning-surface p-4 text-warning sm:mx-5"><strong class="text-3xl leading-none">{{ Math.round((forecast?.riskScore || 0) * 100) }}</strong><span class="text-base font-semibold leading-6">風險排序分／100</span></div>
          <dl class="grid grid-cols-2 gap-3 px-4 py-4 sm:px-5"><div class="rounded-lg border border-line p-3"><dt class="text-base font-semibold text-muted">預估可借車</dt><dd class="mt-1 text-2xl font-bold">{{ forecast?.predictedBikes }}</dd></div><div class="rounded-lg border border-line p-3"><dt class="text-base font-semibold text-muted">預估可還位</dt><dd class="mt-1 text-2xl font-bold">{{ forecast?.predictedDocks }}</dd></div></dl>
        </template>
        <template v-else>
          <div class="mx-4 mt-4 flex flex-col gap-1 rounded-lg bg-surface p-4 sm:mx-5"><span class="text-base font-semibold"><b>{{ unavailableForecastTitle }}</b></span><span class="text-base leading-6 text-muted">{{ unavailableForecastExplanation }}</span></div>
          <dl class="grid grid-cols-2 gap-3 px-4 py-4 sm:px-5"><div class="rounded-lg border border-line p-3"><dt class="text-base font-semibold text-muted">目前可借車</dt><dd class="mt-1 text-2xl font-bold">{{ record.station.availableBikes }}</dd></div><div class="rounded-lg border border-line p-3"><dt class="text-base font-semibold text-muted">目前可還位</dt><dd class="mt-1 text-2xl font-bold">{{ record.station.availableDocks }}</dd></div></dl>
        </template>
        <ul class="space-y-2 border-t border-line px-4 py-4 sm:px-5"><li v-for="reason in forecast?.reasons" :key="reason" class="flex items-start gap-2 text-base leading-6 text-muted"><Icon class="mt-1 shrink-0 text-xl text-accent" icon="solar:check-read-outline" /> {{ reason }}</li></ul>
      </section>
    </div>
    <div v-else-if="activeError" class="loading-board error-board" role="alert"><Icon icon="solar:danger-triangle-outline" />{{ activeError }}<PageRetryButton :busy="activePending" @retry="retryDashboard" /></div>
    <div v-else-if="dashboard" class="loading-board error-board" role="alert"><Icon icon="solar:map-point-remove-outline" />目前資料中找不到這個站點。<NuxtLink :to="{ path: '/', query: contextQuery }">返回營運總覽</NuxtLink></div>
  </div>
</template>
