<script setup lang="ts">
import { Icon } from '@iconify/vue'
import type { DataMode, HorizonKey, StationHistoryPoint, StationRisk } from '~/shared/ops'

const props = defineProps<{
  station: StationRisk | null
  history: StationHistoryPoint[]
  horizon: HorizonKey
  dataMode?: DataMode
}>()

const emit = defineEmits<{ close: [] }>()

const isLive = computed(() => props.dataMode === 'live')
const forecast = computed(() => props.station?.forecast.horizons[props.horizon])
const riskLabel = computed(() => {
  if (isLive.value) {
    const state = props.station?.currentState
    return state === 'empty_now' ? '無車可借' : state === 'full_now' ? '無位可還' : state === 'unavailable' ? '暫停' : '庫存正常'
  }
  return ({ normal: '穩定', medium: '觀察', high: '高風險', critical: '立即處理' }[forecast.value?.level || 'normal'])
})
</script>

<template>
  <aside v-if="station" class="station-detail" aria-label="站點詳情">
    <button type="button" class="close-button" aria-label="關閉站點詳情" @click="emit('close')"><Icon icon="solar:close-circle-outline" /></button>
    <div class="detail-topline"><span>{{ isLive ? '官方即時庫存' : '站點風險卡' }}</span><span :class="`risk-badge risk-${forecast?.level}`">{{ riskLabel }}</span></div>
    <h3>{{ station.name }}</h3>
    <p class="station-location"><Icon icon="solar:map-point-outline" /> {{ station.district || '行政區待確認' }} · {{ station.city }}</p>

    <div class="stock-cells">
      <div><span>可借車</span><strong>{{ station.availableBikes }}</strong></div>
      <div><span>可還位</span><strong>{{ station.availableDocks }}</strong></div>
      <div><span>總車柱</span><strong>{{ station.totalDocks }}</strong></div>
    </div>

    <div class="forecast-note">
      <span><Icon :icon="isLive ? 'solar:bolt-circle-outline' : 'solar:magic-stick-3-outline'" /> {{ isLive ? '目前官方即時庫存' : `${horizon} 分鐘後` }}</span>
      <strong>{{ isLive ? `現況 ${station.availableBikes} 車／${station.availableDocks} 位` : `預測 ${forecast?.predictedBikes} 車／${forecast?.predictedDocks} 位` }}</strong>
      <small>{{ isLive ? '即時資料不推估未來；切換到歷史預測可查看模型判讀。' : `風險分數 ${Math.round((forecast?.riskScore || 0) * 100)} · ${forecast?.confidence === 'high' ? '資料信心高' : '請人工覆核'}` }}</small>
    </div>

    <div v-if="!isLive" class="detail-chart-wrap">
      <div class="mini-heading"><span>最近 24 小時庫存</span><i><b />可借車 <b class="dock-key" />可還位</i></div>
      <ForecastChart :history="history" :station-name="station.name" />
    </div>

    <div class="reason-list">
      <p>{{ isLive ? '即時資料說明' : '模型判讀依據' }}</p>
      <span v-for="reason in forecast?.reasons" :key="reason"><Icon icon="solar:check-read-outline" /> {{ reason }}</span>
      <span v-for="flag in station.qualityFlags" :key="flag" class="quality-flag"><Icon icon="solar:info-circle-outline" /> {{ flag }}</span>
    </div>
    <NuxtLink v-if="!isLive" :to="`/stations/${station.id}`" class="detail-link">開啟完整站點視圖 <Icon icon="solar:arrow-right-outline" /></NuxtLink>
  </aside>
</template>
