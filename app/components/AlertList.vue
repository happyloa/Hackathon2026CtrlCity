<script setup lang="ts">
import { Icon } from '@iconify/vue'
import { displayStationName, type Alert, type StationRisk } from '~/shared/ops'
import { ALERT_PRIORITY_THRESHOLDS } from '~/shared/operational-policy.mjs'

const props = withDefaults(defineProps<{
  alerts: Alert[]
  stations: StationRisk[]
  compact?: boolean
  maxItems?: number
  embedded?: boolean
  contextQuery?: Record<string, string>
  kind?: 'inventory' | 'service'
  title?: string
  emptyMessage?: string
  pageSize?: number
}>(), {
  kind: 'inventory',
  title: '',
  emptyMessage: '目前沒有符合篩選條件的風險。',
  pageSize: 40,
})

const emit = defineEmits<{ select: [stationId: string] }>()
const stationLookup = computed(() => new Map(props.stations.map(station => [station.id, station])))
const visibleCount = ref(props.pageSize)
const visibleAlerts = computed(() => props.compact
  ? props.alerts.slice(0, props.maxItems || 3)
  : props.alerts.slice(0, visibleCount.value))
const remainingCount = computed(() => Math.max(0, props.alerts.length - visibleAlerts.value.length))
const allAlertsTarget = computed(() => ({ path: '/alerts', query: props.contextQuery || {} }))
const sectionTitle = computed(() => props.title || (props.kind === 'service' ? '服務狀態異常' : '庫存風險排序'))

watch(() => props.alerts, () => { visibleCount.value = props.pageSize })

function stationFor(alert: Alert) {
  return stationLookup.value.get(alert.stationId)
}

function stationNameFor(alert: Alert) {
  const station = stationFor(alert)
  return station ? displayStationName(station.name) : '資料未對應站點'
}

function conditionLabel(alert: Alert) {
  if (alert.condition === 'unavailable') {
    return stationFor(alert)?.serviceStatus === 'official_inactive' ? '官方停用' : '疑似服務或資料異常'
  }
  return {
    empty_now: '目前無車可借',
    full_now: '目前無位可還',
    empty_forecast: '60 分鐘缺車風險',
    full_forecast: '60 分鐘缺位風險',
  }[alert.condition]
}

function priorityLabel(score: number) {
  if (score >= ALERT_PRIORITY_THRESHOLDS.immediate) return '立即關注'
  if (score >= ALERT_PRIORITY_THRESHOLDS.high) return '高優先'
  return '需注意'
}

function priorityClasses(score: number) {
  if (score >= ALERT_PRIORITY_THRESHOLDS.immediate) return 'border-danger text-danger'
  if (score >= ALERT_PRIORITY_THRESHOLDS.high) return 'border-warning text-warning'
  return 'border-line-strong text-muted'
}

function inventoryRowClasses(score: number) {
  if (score >= ALERT_PRIORITY_THRESHOLDS.immediate) return 'border-l-danger bg-danger-surface'
  if (score >= ALERT_PRIORITY_THRESHOLDS.high) return 'border-l-warning bg-warning-surface'
  return 'border-l-info bg-info-surface'
}

function inventoryIcon(score: number) {
  return score >= ALERT_PRIORITY_THRESHOLDS.immediate
    ? 'solar:danger-triangle-bold'
    : score >= ALERT_PRIORITY_THRESHOLDS.high ? 'solar:bell-bing-outline' : 'solar:info-circle-outline'
}

function scorePartsLabel(alert: Alert) {
  const parts = alert.scoreParts
  return `風險 ${parts.forecast}＋現況 ${parts.current}＋缺口 ${parts.gap}＋品質 ${parts.quality}`
}
</script>

<template>
  <section :class="embedded ? 'overflow-hidden border-0 bg-transparent shadow-none' : 'panel overflow-hidden'">
    <div v-if="!embedded" class="flex flex-col gap-3 border-b border-line p-4 sm:flex-row sm:items-start sm:justify-between">
      <div>
        <p class="section-kicker text-base"><Icon :icon="kind === 'service' ? 'solar:settings-minimalistic-outline' : 'solar:bell-bing-outline'" /> {{ kind === 'service' ? '營運狀態' : '告警中心' }}</p>
        <h2 class="m-0 mt-1 text-xl font-bold tracking-tight text-ink">{{ sectionTitle }}</h2>
      </div>
      <NuxtLink v-if="compact" :to="allAlertsTarget" class="text-link min-h-11 text-base">查看全部 <Icon icon="solar:arrow-right-up-outline" /></NuxtLink>
    </div>

    <template v-if="visibleAlerts.length">
      <div class="divide-y divide-line">
        <article
          v-for="alert in visibleAlerts"
          :key="alert.id"
          class="flex flex-wrap items-start gap-3 border-l-4 px-4 py-3"
          :class="kind === 'service' ? 'border-l-line-strong bg-panel-muted' : inventoryRowClasses(alert.priorityScore)"
        >
          <span class="grid size-10 shrink-0 place-items-center rounded-full bg-panel text-lg" :class="kind === 'service' ? 'text-muted' : priorityClasses(alert.priorityScore)">
            <Icon :icon="kind === 'service' ? 'solar:settings-minimalistic-outline' : inventoryIcon(alert.priorityScore)" />
          </span>
          <button type="button" class="min-w-0 flex-1 text-left text-base leading-6 text-ink hover:underline" @click="emit('select', alert.stationId)">
            <strong class="block break-words font-bold">{{ stationNameFor(alert) }}</strong>
            <span class="mt-1 block text-muted">{{ conditionLabel(alert) }} · {{ stationFor(alert)?.district || '行政區未標示' }}</span>
            <small v-if="kind === 'inventory'" class="mt-1 block text-base leading-6 text-muted">{{ scorePartsLabel(alert) }}</small>
            <small v-else class="mt-1 block text-base leading-6 text-muted">僅供營運狀態查驗，不納入搬運路線。</small>
          </button>
          <div v-if="kind === 'inventory'" class="ml-auto flex w-full items-center justify-between gap-2 text-base sm:w-auto sm:flex-col sm:items-end">
            <span class="rounded-md border bg-panel px-2 py-1 font-bold" :class="priorityClasses(alert.priorityScore)">{{ priorityLabel(alert.priorityScore) }}</span>
            <strong class="font-mono text-lg text-ink">{{ Math.round(alert.priorityScore) }} 分</strong>
          </div>
          <span v-else class="ml-auto rounded-md border border-line-strong bg-panel px-2 py-1 text-base font-bold text-muted">不納入調度</span>
        </article>
      </div>
      <div v-if="!compact && remainingCount" class="border-t border-line p-3 text-center">
        <button type="button" class="min-h-11 rounded-md border border-line-strong bg-panel px-4 text-base font-bold text-accent transition-colors hover:bg-panel-muted hover:text-accent-strong" @click="visibleCount += pageSize">顯示更多（尚有 {{ remainingCount }} 站）</button>
      </div>
    </template>
    <div v-else class="flex min-h-24 items-center justify-center gap-2 p-4 text-center text-base font-semibold text-positive">
      <Icon class="text-lg" icon="solar:check-circle-outline" />
      <span>{{ emptyMessage }}</span>
    </div>
  </section>
</template>
