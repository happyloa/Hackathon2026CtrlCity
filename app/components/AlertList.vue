<script setup lang="ts">
import { Icon } from '@iconify/vue'
import { displayStationName, type Alert, type StationRisk } from '~/shared/ops'

const props = defineProps<{
  alerts: Alert[]
  stations: StationRisk[]
  compact?: boolean
  contextQuery?: Record<string, string>
}>()

const emit = defineEmits<{
  select: [stationId: string]
  acknowledge: [alertId: string]
}>()

const stationLookup = computed(() => new Map(props.stations.map(station => [station.id, station])))
const visibleAlerts = computed(() => props.compact ? props.alerts.slice(0, 5) : props.alerts)
const allAlertsTarget = computed(() => ({ path: '/alerts', query: props.contextQuery || {} }))

function stationFor(alert: Alert) {
  return stationLookup.value.get(alert.stationId)
}

function stationNameFor(alert: Alert) {
  const station = stationFor(alert)
  return station ? displayStationName(station.name) : '資料未對應站點'
}

function conditionLabel(condition: Alert['condition']) {
  return {
    empty_now: '已無車可借',
    full_now: '已無位可還',
    unavailable: '疑似服務異常（需確認）',
    empty_forecast: '預測將無車',
    full_forecast: '預測將滿位',
  }[condition]
}
</script>

<template>
  <section class="panel alert-panel">
    <div class="panel-heading">
      <div>
        <p class="section-kicker"><Icon icon="solar:bell-bing-outline" /> 告警中心</p>
        <h2>需要值班人員處理</h2>
      </div>
      <NuxtLink v-if="compact" :to="allAlertsTarget" class="text-link">查看全部 <Icon icon="solar:arrow-right-up-outline" /></NuxtLink>
    </div>

    <div v-if="visibleAlerts.length" class="alert-list">
      <article v-for="alert in visibleAlerts" :key="alert.id" class="alert-row" :class="`severity-${alert.severity}`">
        <span class="severity-mark"><Icon :icon="alert.severity === 'critical' ? 'solar:danger-triangle-bold' : 'solar:bell-bing-outline'" /></span>
        <button type="button" class="alert-main" @click="emit('select', alert.stationId)">
          <strong>{{ stationNameFor(alert) }}</strong>
          <span>{{ conditionLabel(alert.condition) }} · {{ alert.durationMinutes > 0 ? `已持續 ${alert.durationMinutes} 分鐘` : '即時偵測' }}</span>
        </button>
        <div class="alert-actions">
          <small>{{ Math.round(alert.riskScore * 100) }} 分</small>
          <button v-if="alert.status === 'open'" type="button" class="quiet-button" @click="emit('acknowledge', alert.id)">確認</button>
          <span v-else class="acknowledged">已確認</span>
        </div>
      </article>
    </div>
    <div v-else class="empty-state">
      <Icon icon="solar:check-circle-outline" />
      <span>目前沒有符合篩選條件的告警。</span>
    </div>
  </section>
</template>
