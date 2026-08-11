<script setup lang="ts">
import { Icon } from '@iconify/vue'
import { displayStationName, type ApiEnvelope, type DashboardArtifact, type LiveStation, type LiveStationsPayload, type StationRisk } from '~/shared/ops'

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
        <p class="section-kicker"><Icon icon="solar:refresh-circle-outline" /> 更新監測</p>
        <h2>{{ updated ? '官方資料已同步' : '等待下一筆官方資料更新' }}</h2>
        <p>新北市政府 Open Data · {{ district || '全新北市' }}</p>
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
      <div v-if="attentionStations.length" class="live-attention-list">
        <p>優先檢視 {{ attentionStations.length }} 個站點</p>
        <div v-for="station in attentionStations" :key="station.id" class="live-attention-row">
          <span class="live-station-name"><b>{{ displayStationName(station.name) }}</b><small>{{ station.district }}</small></span>
          <span class="live-stock">車 {{ station.availableBikes }} · 位 {{ station.availableDocks }}</span>
          <span class="live-status" :class="statusClass(station)">{{ riskLabel(station) }}</span>
          <button type="button" class="text-link" :aria-label="`在地圖定位 ${displayStationName(station.name)}`" @click="emit('select', station.id)">地圖定位 <Icon icon="solar:map-point-outline" /></button>
        </div>
      </div>
      <p v-else-if="!pending" class="live-feed-empty">目前沒有需要優先處理的即時站點。</p>
    </template>
  </section>
</template>
