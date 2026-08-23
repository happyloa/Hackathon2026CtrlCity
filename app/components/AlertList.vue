<script setup lang="ts">
import { Icon } from '@iconify/vue'
import { displayStationName, type Alert, type StationRisk } from '~/shared/ops'

const props = defineProps<{
  alerts: Alert[]
  stations: StationRisk[]
  compact?: boolean
  maxItems?: number
  embedded?: boolean
  contextQuery?: Record<string, string>
}>()

const emit = defineEmits<{
  select: [stationId: string]
  acknowledge: [alertId: string]
}>()

const stationLookup = computed(() => new Map(props.stations.map(station => [station.id, station])))
const visibleAlerts = computed(() => props.compact ? props.alerts.slice(0, props.maxItems || 3) : props.alerts)
const allAlertsTarget = computed(() => ({ path: '/alerts', query: props.contextQuery || {} }))
const containerClasses = {
  default: 'panel overflow-hidden',
  embedded: 'overflow-hidden border-0 bg-transparent shadow-none',
} as const
const severityRowClasses = {
  medium: 'border-l-warning bg-warning-surface',
  high: 'border-l-warning bg-warning-surface',
  critical: 'border-l-danger bg-danger-surface',
} as const
const severityIconClasses = {
  medium: 'bg-warning-surface text-warning',
  high: 'bg-warning-surface text-warning',
  critical: 'bg-danger-surface text-danger',
} as const

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
    empty_forecast: '後續缺車風險',
    full_forecast: '後續缺位風險',
  }[condition]
}
</script>

<template>
  <section :class="embedded ? containerClasses.embedded : containerClasses.default">
    <div v-if="!embedded" class="flex flex-col gap-3 border-b border-line p-4 sm:flex-row sm:items-start sm:justify-between">
      <div>
        <p class="section-kicker text-base"><Icon icon="solar:bell-bing-outline" /> 告警中心</p>
        <h2 class="m-0 mt-1 text-xl font-bold tracking-tight text-ink">需要值班人員處理</h2>
      </div>
      <NuxtLink v-if="compact" :to="allAlertsTarget" class="text-link min-h-11 text-base">查看全部 <Icon icon="solar:arrow-right-up-outline" /></NuxtLink>
    </div>

    <div v-if="visibleAlerts.length" class="divide-y divide-line">
      <article
        v-for="alert in visibleAlerts"
        :key="alert.id"
        class="flex items-start gap-3 border-l-4 px-4 py-3"
        :class="severityRowClasses[alert.severity]"
      >
        <span class="grid size-10 shrink-0 place-items-center rounded-full text-lg" :class="severityIconClasses[alert.severity]">
          <Icon :icon="alert.severity === 'critical' ? 'solar:danger-triangle-bold' : 'solar:bell-bing-outline'" />
        </span>
        <button type="button" class="min-w-0 flex-1 text-left text-base leading-6 text-ink hover:underline" @click="emit('select', alert.stationId)">
          <strong class="block break-words font-bold">{{ stationNameFor(alert) }}</strong>
          <span class="mt-1 block text-muted">{{ conditionLabel(alert.condition) }} · {{ alert.durationMinutes > 0 ? `已持續 ${alert.durationMinutes} 分鐘` : '即時偵測' }}</span>
        </button>
        <div class="flex shrink-0 flex-col items-end gap-2 text-base">
          <small class="font-bold text-muted">{{ Math.round(alert.riskScore * 100) }} 分</small>
          <button v-if="alert.status === 'open'" type="button" class="min-h-11 rounded-md border border-line-strong bg-panel px-3 font-bold text-accent transition-colors hover:bg-panel-muted hover:text-accent-strong" @click="emit('acknowledge', alert.id)">確認</button>
          <span v-else class="rounded-md border border-line bg-panel px-3 py-2 font-bold text-muted">已確認</span>
        </div>
      </article>
    </div>
    <div v-else class="flex min-h-24 items-center justify-center gap-2 p-4 text-center text-base font-semibold text-positive">
      <Icon class="text-lg" icon="solar:check-circle-outline" />
      <span>目前沒有符合篩選條件的告警。</span>
    </div>
  </section>
</template>
