<script setup lang="ts">
import { Icon } from '@iconify/vue'
import type { ApiEnvelope, DashboardArtifact, LiveStation, LiveStationsPayload, StationRisk } from '~/shared/ops'

type LiveResponse = ApiEnvelope<LiveStationsPayload>

const props = defineProps<{
  district?: string
  payload: LiveResponse | null
  dashboard?: DashboardArtifact | null
  pending?: boolean
  errorMessage?: string
  updated?: boolean
}>()

const emit = defineEmits<{ refresh: []; select: [stationId: string] }>()

const stations = computed(() => props.payload?.data.stations ?? [])
const emptyCount = computed(() => stations.value.filter(station => station.currentState === 'empty_now').length)
const fullCount = computed(() => stations.value.filter(station => station.currentState === 'full_now').length)
const unavailableCount = computed(() => stations.value.filter(station => station.serviceStatus !== 'operational').length)
const highRiskCount = computed(() => props.dashboard?.summary.highRiskNext60m || 0)
const attentionStations = computed(() => {
  const priority = (station: StationRisk) => {
    if (station.serviceStatus !== 'operational') return 0
    if (station.currentState === 'empty_now') return 1
    if (station.currentState === 'full_now') return 2
    const forecast = station.forecast.horizons['60']
    return forecast.level === 'critical' ? 3 : forecast.level === 'high' ? 4 : 5
  }
  return [...(props.dashboard?.stations || [])]
    .filter((station) => station.serviceStatus !== 'operational' || station.currentState !== 'normal' || ['high', 'critical'].includes(station.forecast.horizons['60'].level))
    .sort((left, right) => priority(left) - priority(right) || right.forecast.horizons['60'].riskScore - left.forecast.horizons['60'].riskScore)
    .slice(0, 5)
})

const sourceTime = computed(() => {
  const value = props.payload?.meta.asOf
  if (!value) return '尚未載入'
  return new Intl.DateTimeFormat('zh-TW', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date(value))
})

function statusLabel(station: Pick<LiveStation, 'currentState' | 'serviceStatus'>) {
  if (station.serviceStatus === 'official_inactive') return '官方未啟用'
  if (station.serviceStatus === 'suspected_unavailable') return '疑似服務異常'
  if (station.currentState === 'empty_now') return '暫無可借車'
  if (station.currentState === 'full_now') return '暫無可還位'
  return '正常'
}

function riskLabel(station: StationRisk) {
  const forecast = station.forecast.horizons['60']
  if (station.serviceStatus !== 'operational') return statusLabel(station)
  if (station.currentState === 'empty_now' || forecast.emptyRisk >= forecast.alertThreshold) return `+60m 無車指標 ${Math.round(forecast.emptyRisk * 100)}／100`
  if (station.currentState === 'full_now' || forecast.fullRisk >= forecast.alertThreshold) return `+60m 無位指標 ${Math.round(forecast.fullRisk * 100)}／100`
  return '基線穩定'
}

function statusClass(station: StationRisk) {
  const forecast = station.forecast.horizons['60']
  if (station.serviceStatus !== 'operational') return 'unavailable'
  if (station.currentState === 'empty_now' || forecast.emptyRisk >= forecast.alertThreshold) return 'forecast-empty'
  if (station.currentState === 'full_now' || forecast.fullRisk >= forecast.alertThreshold) return 'forecast-full'
  return 'normal'
}
</script>

<template>
  <section class="panel live-feed-card" :class="{ updated }" aria-label="官方即時站況">
    <div class="live-feed-heading">
      <div>
        <p class="section-kicker"><Icon icon="solar:bolt-circle-outline" /> 官方即時站況</p>
        <h2>來源更新時，才替換畫面資料。</h2>
        <p>新北市政府 Open Data · 每 5 分鐘比對 · {{ district || '全新北市' }}</p>
      </div>
      <div class="live-feed-action">
        <span><i class="live-dot" /> {{ updated ? '已同步新資料' : sourceTime }}</span>
        <button type="button" :disabled="pending" @click="emit('refresh')">
          <Icon :icon="pending ? 'svg-spinners:3-dots-fade' : 'solar:refresh-circle-outline'" />
          {{ pending ? '比對中' : '立即比對' }}
        </button>
      </div>
    </div>

    <p v-if="errorMessage" class="live-feed-error"><Icon icon="solar:danger-triangle-outline" /> {{ errorMessage }}</p>

    <template v-else>
      <div class="live-metric-grid">
        <div><span>已接入站點</span><strong>{{ stations.length.toLocaleString() }}</strong></div>
        <div><span>暫無可借車</span><strong>{{ emptyCount }}</strong></div>
        <div><span>暫無可還位</span><strong>{{ fullCount }}</strong></div>
        <div><span>待人工確認</span><strong>{{ unavailableCount }}</strong></div>
        <div><span>60 分鐘高風險</span><strong>{{ highRiskCount }}</strong></div>
      </div>

      <div v-if="attentionStations.length" class="live-attention-list">
        <p>需要注意的即時與基線風險站點</p>
        <div v-for="station in attentionStations" :key="station.id" class="live-attention-row">
          <span class="live-station-name"><b>{{ station.name.replace(/^YouBike2\.0_/, '') }}</b><small>{{ station.district }}</small></span>
          <span class="live-stock">車 {{ station.availableBikes }} · 位 {{ station.availableDocks }}</span>
          <span class="live-status" :class="statusClass(station)">{{ riskLabel(station) }}</span>
          <button type="button" class="text-link" :aria-label="`在地圖定位 ${station.name}`" @click="emit('select', station.id)">地圖定位 <Icon icon="solar:map-point-outline" /></button>
        </div>
      </div>
      <p v-else-if="!pending" class="live-feed-empty">目前沒有需要優先處理的即時站點。</p>
    </template>
  </section>
</template>
