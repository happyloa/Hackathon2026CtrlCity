<script setup lang="ts">
import { Icon } from '@iconify/vue'
import { buildDispatchRoutePlans, DEFAULT_DISPATCH_ROUTE_POLICY } from '~/shared/dispatch-route-planner'
import type { Alert, DispatchRecommendation, StationRisk } from '~/shared/ops'

const props = defineProps<{
  alerts: Alert[]
  dispatches: DispatchRecommendation[]
  stations: StationRisk[]
  contextQuery?: Record<string, string>
}>()

const emit = defineEmits<{ select: [stationId: string] }>()
const inventoryAlerts = computed(() => props.alerts.filter(alert => alert.condition !== 'unavailable'))
const serviceAlertCount = computed(() => props.alerts.filter(alert => alert.condition === 'unavailable').length)
const routeCount = computed(() => buildDispatchRoutePlans(props.dispatches, props.stations).routes.length)
const headline = computed(() => routeCount.value
  ? `${routeCount.value} 條搬運路線`
  : inventoryAlerts.value.length
    ? `${inventoryAlerts.value.length} 個風險站暫無可行供需配對`
    : '目前沒有需要處理的庫存風險')
const allRoutesTarget = computed(() => ({ path: '/dispatch', query: props.contextQuery || {} }))
const allStationsTarget = computed(() => ({ path: '/stations', query: props.contextQuery || {} }))
</script>

<template>
  <section class="panel overflow-hidden" aria-labelledby="task-queue-title">
    <header class="flex flex-col gap-3 border-b border-line p-4 sm:flex-row sm:items-start sm:justify-between">
      <div>
        <p class="section-kicker text-base"><Icon icon="solar:routing-2-outline" /> 搬運摘要</p>
        <h2 id="task-queue-title" class="m-0 mt-1 text-xl font-bold tracking-tight text-ink">{{ headline }}</h2>
      </div>
      <span class="self-start rounded-md border border-line bg-panel-muted px-2 py-1 text-base font-semibold text-muted">{{ inventoryAlerts.length }} 個風險站</span>
    </header>

    <div class="divide-y divide-line">
      <section aria-labelledby="route-step-title">
        <div class="flex flex-wrap items-start gap-3 p-4 pb-2">
          <span class="grid size-8 shrink-0 place-items-center rounded-full bg-accent font-mono text-base font-bold text-on-accent">1</span>
          <div class="min-w-0 flex-1">
            <strong id="route-step-title" class="block text-base text-ink">多站搬運規劃</strong>
            <small class="mt-1 block text-base leading-6 text-muted">每車 {{ DEFAULT_DISPATCH_ROUTE_POLICY.vehicleCapacity }} 台，合併附近需求。</small>
          </div>
          <NuxtLink :to="allRoutesTarget" class="text-link ml-auto min-h-11 text-base">完整規劃 <Icon icon="solar:arrow-right-up-outline" /></NuxtLink>
        </div>
        <RoutePlanList embedded compact :max-items="1" :dispatches="dispatches" :stations="stations" :context-query="contextQuery" @select="emit('select', $event)" />
      </section>

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
