<script setup lang="ts">
import { Icon } from '@iconify/vue'
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
const allStationsTarget = computed(() => ({ path: '/stations', query: props.contextQuery || {} }))
</script>

<template>
  <section class="panel overflow-hidden" aria-labelledby="task-queue-title">
    <header class="flex flex-col gap-3 border-b border-line p-4 sm:flex-row sm:items-start sm:justify-between">
      <div>
        <p class="section-kicker text-base"><Icon icon="solar:routing-2-outline" /> 派遣摘要</p>
        <h2 id="task-queue-title" class="m-0 mt-1 text-xl font-bold tracking-tight text-ink">{{ headline }}</h2>
      </div>
      <span class="self-start rounded-md border border-line bg-panel-muted px-2 py-1 text-base font-semibold text-muted">{{ inventoryAlerts.length }} 個風險站</span>
    </header>

    <div class="divide-y divide-line">
      <DispatchRouteSummary v-model="activeHorizon" :stations="stations" :as-of="asOf" :context-query="contextQuery"
        @select="emit('select', $event)" @observe-route="emit('observeRoute', $event)" />

      <section aria-labelledby="alert-step-title">
        <div class="flex flex-wrap items-start gap-3 p-4 pb-2">
          <span class="grid size-8 shrink-0 place-items-center rounded-full bg-accent font-mono text-base font-bold text-on-accent">2</span>
          <div class="min-w-0 flex-1">
            <strong id="alert-step-title" class="block text-base text-ink">站點狀態</strong>
            <small class="mt-1 block text-base leading-6 text-muted">風險站排在前面。</small>
          </div>
          <NuxtLink :to="allStationsTarget" class="text-link ml-auto min-h-11 text-base">站點總覽 <Icon icon="solar:arrow-right-up-outline" /></NuxtLink>
        </div>
        <AlertList embedded compact :max-items="1" :alerts="inventoryAlerts" :stations="stations" :context-query="contextQuery" @select="emit('select', $event)" />
      </section>
    </div>

    <p v-if="serviceAlertCount" class="m-0 flex items-start gap-2 border-t border-line bg-panel-muted p-4 text-base font-semibold leading-6 text-muted">
      <Icon class="mt-1 shrink-0 text-lg text-warning" icon="solar:shield-warning-outline" />
      <span>{{ serviceAlertCount }} 個服務異常站未排入路線。</span>
    </p>
  </section>
</template>
