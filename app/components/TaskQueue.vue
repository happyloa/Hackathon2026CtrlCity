<script setup lang="ts">
import { Icon } from '@iconify/vue'
import { buildDispatchRoutePlans, DEFAULT_DISPATCH_ROUTE_POLICY } from '~/shared/dispatch-route-planner'
import { DEFAULT_LIVE_OPERATION_POLICY } from '~/shared/live-operations'
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
  ? `${routeCount.value} 條建議路線，整合 ${props.dispatches.length} 筆搬運需求`
  : inventoryAlerts.value.length
    ? `${inventoryAlerts.value.length} 個風險站暫無可行供需配對`
    : '目前沒有需要處理的庫存風險')
const allRoutesTarget = computed(() => ({ path: '/dispatch', query: props.contextQuery || {} }))
const allAlertsTarget = computed(() => ({ path: '/alerts', query: props.contextQuery || {} }))
</script>

<template>
  <section class="panel overflow-hidden" aria-labelledby="task-queue-title">
    <header class="flex flex-col gap-3 border-b border-line p-4 sm:flex-row sm:items-start sm:justify-between">
      <div>
        <p class="section-kicker text-base"><Icon icon="solar:routing-2-outline" /> 調度分析摘要</p>
        <h2 id="task-queue-title" class="m-0 mt-1 text-xl font-bold tracking-tight text-ink">{{ headline }}</h2>
        <p class="m-0 mt-2 text-base leading-6 text-muted">全部風險皆可查閱；未來預測需有歷史基線，當下空／滿則可直接依官方庫存互補配對。</p>
      </div>
      <div class="flex flex-wrap gap-2 text-base" aria-label="分析數量">
        <span class="rounded-md border border-line bg-panel-muted px-2 py-1 font-semibold text-muted"><b class="font-mono text-accent">{{ routeCount }}</b> 路線</span>
        <span class="rounded-md border border-line bg-panel-muted px-2 py-1 font-semibold text-muted"><b class="font-mono text-accent">{{ dispatches.length }}</b> 搬運</span>
        <span class="rounded-md border border-line bg-panel-muted px-2 py-1 font-semibold text-muted"><b class="font-mono text-accent">{{ inventoryAlerts.length }}</b> 風險</span>
      </div>
    </header>

    <div class="divide-y divide-line">
      <section aria-labelledby="route-step-title">
        <div class="flex flex-wrap items-start gap-3 p-4 pb-2">
          <span class="grid size-8 shrink-0 place-items-center rounded-full bg-accent font-mono text-base font-bold text-on-accent">1</span>
          <div class="min-w-0 flex-1">
            <strong id="route-step-title" class="block text-base text-ink">多站搬運規劃</strong>
            <small class="mt-1 block text-base leading-6 text-muted">評估前 {{ DEFAULT_LIVE_OPERATION_POLICY.maximumAlerts }} 筆可搬運風險，最多產生 {{ DEFAULT_LIVE_OPERATION_POLICY.maximumDispatches }} 筆站間建議；每車 {{ DEFAULT_DISPATCH_ROUTE_POLICY.vehicleCapacity }} 台，再合併鄰近站點。</small>
          </div>
          <NuxtLink :to="allRoutesTarget" class="text-link ml-auto min-h-11 text-base">完整規劃 <Icon icon="solar:arrow-right-up-outline" /></NuxtLink>
        </div>
        <RoutePlanList embedded compact :max-items="1" :dispatches="dispatches" :stations="stations" :context-query="contextQuery" @select="emit('select', $event)" />
      </section>

      <section aria-labelledby="alert-step-title">
        <div class="flex flex-wrap items-start gap-3 p-4 pb-2">
          <span class="grid size-8 shrink-0 place-items-center rounded-full bg-accent font-mono text-base font-bold text-on-accent">2</span>
          <div class="min-w-0 flex-1">
            <strong id="alert-step-title" class="block text-base text-ink">庫存風險依據</strong>
            <small class="mt-1 block text-base leading-6 text-muted">優先分數拆解未來風險、當下狀態、庫存缺口與資料品質。</small>
          </div>
          <NuxtLink :to="allAlertsTarget" class="text-link ml-auto min-h-11 text-base">全部風險 <Icon icon="solar:arrow-right-up-outline" /></NuxtLink>
        </div>
        <AlertList embedded compact :max-items="1" :alerts="inventoryAlerts" :stations="stations" :context-query="contextQuery" @select="emit('select', $event)" />
      </section>
    </div>

    <p class="m-0 flex items-start gap-2 border-t border-line bg-panel-muted p-4 text-base font-semibold leading-6 text-muted">
      <Icon class="mt-1 shrink-0 text-lg text-warning" icon="solar:shield-warning-outline" />
      <span><template v-if="serviceAlertCount">另有 {{ serviceAlertCount }} 個服務狀態異常站，已排除於路線。</template> 本平台只提供分析，不會送出派車命令。</span>
    </p>
  </section>
</template>
