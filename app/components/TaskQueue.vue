<script setup lang="ts">
import { ArrowRight, ArrowUpRight, ChevronDown, ShieldAlert } from '@lucide/vue'
import { buildDispatchRoutePlans, type DispatchRouteStop } from '~/shared/dispatch-route-planner'
import { buildLiveOperationsForHorizon, type DispatchHorizon } from '~/shared/live-operations'
import type { Alert, StationRisk } from '~/shared/ops'

const props = defineProps<{
  alerts: Alert[]
  stations: StationRisk[]
  asOf: string
  contextQuery?: Record<string, string>
}>()

const emit = defineEmits<{ select: [stationId: string], observeRoute: [stops: DispatchRouteStop[] | null] }>()
const activeHorizon = ref<DispatchHorizon>('now')
const inventoryAlerts = computed(() => props.alerts.filter(alert => alert.condition !== 'unavailable'))
const serviceAlertCount = computed(() => props.alerts.filter(alert => alert.condition === 'unavailable').length)
// Kept in sync with DispatchRouteSummary's active tab (via v-model) so this
// count always describes what the panel below is actually showing.
const routeCount = computed(() => {
  const dispatches = buildLiveOperationsForHorizon(props.stations, props.asOf, activeHorizon.value).dispatches
  return buildDispatchRoutePlans(dispatches, props.stations).routes.length
})
const headline = computed(() => routeCount.value
  ? `${routeCount.value} 條派遣路線`
  : inventoryAlerts.value.length
    ? `${inventoryAlerts.value.length} 個風險站暫無可行供需配對`
    : '目前沒有需要處理的庫存風險')
const dispatchTarget = computed(() => ({ path: '/dispatch', query: props.contextQuery || {} }))
const allStationsTarget = computed(() => ({ path: '/stations', query: props.contextQuery || {} }))
</script>

<template>
  <section class="panel route-workspace" aria-labelledby="task-queue-title">
    <header class="route-workspace-heading">
      <div><h2 id="task-queue-title">優先搬運路線</h2><p class="route-count"><b>{{ routeCount }}</b> 條可行路線</p></div>
      <NuxtLink :to="dispatchTarget" class="ops-button button-primary" aria-label="前往調度規劃">調度規劃<ArrowRight style="width: 1em; height: 1em" :stroke-width="2" aria-hidden="true" /></NuxtLink>
    </header>
    <DispatchRouteSummary v-model="activeHorizon" :stations="stations" :as-of="asOf" :context-query="contextQuery"
      @select="emit('select', $event)" @observe-route="emit('observeRoute', $event)" />
    <details class="queue-station-details">
      <summary><span>其他站點風險 <b>{{ inventoryAlerts.length }}</b></span><span class="queue-time-label">60 分鐘<ChevronDown style="width: 1em; height: 1em" :stroke-width="2" aria-hidden="true" /></span></summary>
      <div class="queue-station-content">
        <AlertList embedded compact :max-items="1" :alerts="inventoryAlerts" :stations="stations" :context-query="contextQuery" @select="emit('select', $event)" />
        <NuxtLink :to="allStationsTarget" class="ops-button button-secondary">查看全部站點<ArrowUpRight style="width: 1em; height: 1em" :stroke-width="2" aria-hidden="true" /></NuxtLink>
      </div>
    </details>
    <p v-if="serviceAlertCount" class="service-exclusion"><ShieldAlert style="width: 1em; height: 1em" :stroke-width="2" aria-hidden="true" />{{ serviceAlertCount }} 個服務異常站未排入路線</p>
  </section>
</template>

<style scoped>
.route-workspace { overflow: hidden; }
.route-workspace-heading { display: flex; justify-content: space-between; align-items: center; gap: 10px; padding: 16px 20px; border-bottom: 1px solid var(--line); }
.route-workspace-heading p { display: flex; align-items: center; gap: 6px; color: var(--muted); font-size: 12px; margin-bottom: 5px; }
.route-workspace-heading p svg { font-size: 16px; color: var(--accent); }
.route-workspace-heading h2 { font-size: 19px; font-weight: 650; letter-spacing: -.025em; }
.route-workspace-heading .route-count { font-size: 12px; white-space: nowrap; color: var(--muted); padding-top: 3px; margin-bottom: 0; }
.route-count b { color: var(--accent); font-size: 15px; font-variant-numeric: tabular-nums; }
.route-primary-action { padding: 0 20px 18px; display: grid; gap: 7px; text-align: center; }
.route-primary-action .ops-button { min-height: 46px; }
.route-primary-action .ops-button svg:last-child { margin-left: auto; }
.route-primary-action .ops-button svg:first-child { margin-right: auto; }
.route-primary-action > span { font-size: 12px; color: var(--muted); }
.queue-station-details { border-top: 1px solid var(--line); }
.queue-station-details summary { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 14px 20px; font-size: 14px; cursor: pointer; list-style: none; }
.queue-station-details summary::-webkit-details-marker { display: none; }
.queue-station-details summary b { color: var(--muted); margin-left: 5px; font-size: 13px; font-weight: 500; }
.queue-time-label { display: flex; align-items: center; gap: 10px; color: var(--muted); font-size: 12px; }
.queue-station-details[open] .queue-time-label svg { transform: rotate(180deg); }
.queue-station-content { padding: 0 14px 16px; }
.service-exclusion { display: flex; align-items: center; gap: 7px; border-top: 1px solid var(--line); color: var(--muted); font-size: 12px; padding: 12px 20px; }
.service-exclusion svg { color: var(--warning); font-size: 16px; }
</style>
