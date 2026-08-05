<script setup lang="ts">
import { Icon } from '@iconify/vue'
import type { ApiEnvelope, HorizonKey, StationHistoryPoint, StationRisk } from '~/shared/ops'

const route = useRoute()
const stationId = computed(() => String(route.params.stationId))
const horizon = ref<HorizonKey>('60')
const horizonOptions: HorizonKey[] = ['30', '60', '120']
const { data: payload, error } = await useFetch<ApiEnvelope<{ station: StationRisk; history: StationHistoryPoint[] }>>(() => `/api/v1/stations/${stationId.value}`)
const record = computed(() => payload.value?.data)
const forecast = computed(() => record.value?.station.forecast.horizons[horizon.value])
</script>

<template>
  <div class="subpage station-page">
    <NuxtLink to="/" class="back-link"><Icon icon="solar:arrow-left-outline" /> 返回調度戰情室</NuxtLink>
    <section v-if="record" class="station-hero panel">
      <div>
        <p class="section-kicker"><Icon icon="solar:map-point-outline" /> {{ record.station.district || '行政區待確認' }} · {{ record.station.city }}</p>
        <h2>{{ record.station.name }}</h2>
        <p>以站點的歷史時段基線、近期庫存與容量狀態，評估未來空車與滿位風險。</p>
      </div>
      <div class="station-hero-stock">
        <span>可借車 <b>{{ record.station.availableBikes }}</b></span>
        <span>可還位 <b>{{ record.station.availableDocks }}</b></span>
      </div>
    </section>
    <div v-if="record" class="station-insight-grid">
      <section class="panel chart-panel">
        <div class="panel-heading"><div><p class="section-kicker">庫存趨勢</p><h2>最近 24 小時</h2></div></div>
        <ForecastChart :history="record.history" :station-name="record.station.name" />
      </section>
      <section class="panel forecast-panel">
        <div class="panel-heading"><div><p class="section-kicker">風險模型</p><h2>下一個時段</h2></div></div>
        <div class="horizon-buttons"><button v-for="item in horizonOptions" :key="item" type="button" :class="{ active: horizon === item }" @click="horizon = item">{{ item }} 分鐘</button></div>
        <div class="forecast-score"><strong>{{ Math.round((forecast?.riskScore || 0) * 100) }}</strong><span>風險分數</span></div>
        <dl><div><dt>預測可借車</dt><dd>{{ forecast?.predictedBikes }}</dd></div><div><dt>預測可還位</dt><dd>{{ forecast?.predictedDocks }}</dd></div></dl>
        <ul><li v-for="reason in forecast?.reasons" :key="reason"><Icon icon="solar:check-read-outline" /> {{ reason }}</li></ul>
      </section>
    </div>
    <div v-else-if="error" class="loading-board error-board">找不到此站點資料。</div>
  </div>
</template>
