<script setup lang="ts">
import { Icon } from '@iconify/vue'
import type { HorizonKey, StationHistoryPoint, StationRisk } from '~/shared/ops'

const route = useRoute()
const replay = useReplayDashboard()
const stationId = computed(() => String(route.params.stationId))
const horizon = ref<HorizonKey>('60')
const horizonOptions: HorizonKey[] = ['30', '60', '120']
const dashboard = computed(() => replay.dashboardForDistrict())
const record = computed<{ station: StationRisk; history: StationHistoryPoint[] } | null>(() => {
  const station = dashboard.value?.stations.find(candidate => candidate.id === stationId.value)
  return station ? { station, history: dashboard.value?.stationHistories[station.id] || [] } : null
})
const forecast = computed(() => record.value?.station.forecast.horizons[horizon.value])

onMounted(() => {
  void replay.loadScenario()
})
</script>

<template>
  <div class="subpage station-page">
    <NuxtLink to="/" class="back-link"><Icon icon="solar:arrow-left-outline" /> 回到調度雷達</NuxtLink>
    <div v-if="replay.pending && !record" class="loading-board"><Icon icon="svg-spinners:3-dots-fade" />正在載入站點歷史…</div>
    <section v-else-if="record" class="station-hero panel">
      <div>
        <p class="section-kicker"><Icon icon="solar:map-point-outline" /> {{ record.station.district || '未分類' }} ・ {{ record.station.city }}</p>
        <h2>{{ record.station.name }}</h2>
        <p>這是歷史回放時點的庫存與風險資料，可用來解釋調度優先順序。</p>
      </div>
      <div class="station-hero-stock">
        <span>可借車 <b>{{ record.station.availableBikes }}</b></span>
        <span>可還位 <b>{{ record.station.availableDocks }}</b></span>
      </div>
    </section>
    <div v-if="record" class="station-insight-grid">
      <section class="panel chart-panel">
        <div class="panel-heading"><div><p class="section-kicker">歷史庫存走勢</p><h2>最近 24 小時</h2></div></div>
        <ForecastChart :history="record.history" :station-name="record.station.name" />
      </section>
      <section class="panel forecast-panel">
        <div class="panel-heading"><div><p class="section-kicker">歷史資料推估</p><h2>風險細節</h2></div></div>
        <div class="horizon-buttons"><button v-for="item in horizonOptions" :key="item" type="button" :class="{ active: horizon === item }" @click="horizon = item">{{ item }} 分鐘</button></div>
        <div class="forecast-score"><strong>{{ Math.round((forecast?.riskScore || 0) * 100) }}</strong><span>風險分數</span></div>
        <dl><div><dt>預估可借車</dt><dd>{{ forecast?.predictedBikes }}</dd></div><div><dt>預估可還位</dt><dd>{{ forecast?.predictedDocks }}</dd></div></dl>
        <ul><li v-for="reason in forecast?.reasons" :key="reason"><Icon icon="solar:check-read-outline" /> {{ reason }}</li></ul>
      </section>
    </div>
    <div v-else-if="replay.error" class="loading-board error-board">{{ replay.error }}</div>
  </div>
</template>
