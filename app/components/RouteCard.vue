<script setup lang="ts">
import { ChevronDown, ChevronRight, MapPin, Route } from '@lucide/vue'
import type { DispatchRoutePlan, DispatchRouteStopAction } from '~/shared/dispatch-route-planner'

const props = defineProps<{
  route: DispatchRoutePlan
  /** Zero-based position, used only for the "路線 N" label. */
  index: number
  compact?: boolean
}>()

const expanded = ref(false)
const stopsId = useId()
const endpoints = computed(() => props.route.stops.length > 1 ? [props.route.stops[0]!, props.route.stops[props.route.stops.length - 1]!] : props.route.stops)

const emit = defineEmits<{ select: [stationId: string] }>()

watch(() => props.route.id, () => { expanded.value = false })

function actionLabel(action: DispatchRouteStopAction) {
  return { pickup: '取車', dropoff: '卸車', mixed: '卸車＋取車' }[action]
}

function actionClasses(action: DispatchRouteStopAction) {
  if (action === 'pickup') return 'text-info'
  if (action === 'dropoff') return 'text-danger'
  return 'border border-info bg-panel text-info'
}

/**
 * A full-saturation pastel fill across the whole row read as too loud, so
 * pickup/dropoff are a dark card (same as every other row) with a colored
 * left border plus a faint tint of the same color -- the same "accent bar +
 * low-opacity wash" treatment `StationDetailPanel.vue` already uses for its
 * return/borrow guidance sections. Text stays the normal `text-ink`/
 * `text-muted` pairing since the background is still dark.
 */
function rowClasses(action: DispatchRouteStopAction) {
  if (action === 'pickup') return 'border-l-4 border-l-info bg-info/10'
  if (action === 'dropoff') return 'border-l-4 border-l-danger bg-danger/10'
  return 'bg-panel-muted'
}

function stopPinColor(stop: DispatchRoutePlan['stops'][number]) {
  if (stop.sequence === 1) return '#3ecf8e'
  if (stop.action === 'pickup') return '#7dd3fc'
  return '#ff6f61'
}
</script>

<template>
  <article class="p-4" :class="{ 'route-preview': compact }">
    <div v-if="compact" class="compact-route">
      <div class="compact-route-title"><h3>路線 {{ String(index + 1).padStart(2, '0') }}</h3><span>優先分數 <b>{{ Math.round(route.highestPriorityScore) }}</b></span></div>
      <div class="compact-route-metrics"><strong>{{ route.stops.length }}<small>站</small></strong><span class="route-metric-divider" /><strong>{{ route.totalTransferBikes }}<small>台搬運</small></strong><span class="route-estimate">站間估距 {{ route.totalDistanceKm.toFixed(1) }} km</span></div>
    </div>
    <template v-else>
    <div class="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
      <div class="min-w-0">
        <span class="inline-flex items-center gap-2 text-base font-bold text-accent">
          <Route :size="18" :stroke-width="2" aria-hidden="true" /> 路線 {{ index + 1 }}
        </span>
        <h3 class="m-0 mt-1 text-lg font-bold text-ink">{{ route.stops.length }} 站 · 搬運 {{ route.totalTransferBikes }} 台
        </h3>
      </div>
      <div class="flex flex-wrap gap-2 text-base text-muted sm:justify-end">
        <span class="rounded-md border border-line bg-panel-muted px-2 py-1">約 {{ route.totalDistanceKm.toFixed(1) }}
          km</span>
        <span class="rounded-md border border-line bg-panel-muted px-2 py-1">載量 {{ route.peakVehicleLoad }}/{{
          route.vehicleCapacity }}</span>
        <span class="rounded-md border border-line bg-panel-muted px-2 py-1">{{ route.taskCount }} 筆需求 · 優先 {{
          Math.round(route.highestPriorityScore) }}</span>
      </div>
    </div>

    </template>

    <section :class="{ 'route-stops': compact }" :aria-label="`路線 ${index + 1} 停靠站點`">
      <button v-if="compact" type="button" class="route-expand" :aria-expanded="expanded" :aria-controls="stopsId" @click="expanded = !expanded">
        <span class="route-expand-title">停靠站點 <span>· {{ route.stops.length }} 站</span></span>
        <span class="route-expand-action">{{ expanded ? '收合路線' : '展開路線' }}<ChevronDown :size="18" :stroke-width="2" aria-hidden="true" :class="{ 'rotate-180': expanded }" /></span>
      </button>
      <div :id="stopsId">
        <div v-if="compact && !expanded" class="route-endpoints" aria-label="路線起點與終點摘要">
          <template v-for="(stop, endpointIndex) in endpoints" :key="`${route.id}:${stop.sequence}`">
            <button type="button" class="route-endpoint" :aria-label="`查看第 ${stop.sequence} 站 ${stop.stationName} 詳情`" @click="emit('select', stop.stationId)">
              <span class="route-list-stop-marker relative shrink-0" aria-hidden="true">
                <MapPin class="route-list-stop-pin" :style="{ color: stopPinColor(stop) }" :size="42"
                  :stroke-width="1.75" />
                <span class="route-list-stop-number absolute grid place-items-center rounded-full font-mono font-bold text-black"
                  :style="{ backgroundColor: stopPinColor(stop) }">{{ stop.sequence }}</span>
              </span>
              <span class="endpoint-content"><small>{{ endpoints.length === 1 ? '停靠站' : endpointIndex === 0 ? '起點' : '終點' }} · {{ actionLabel(stop.action) }}</small><strong>{{ stop.stationName }}</strong></span>
              <ChevronRight :size="18" :stroke-width="2" aria-hidden="true" />
            </button>
            <p v-if="endpointIndex === 0 && route.stops.length > 2" class="route-endpoint-gap"><span aria-hidden="true">⋮</span>途經 {{ route.stops.length - 2 }} 站</p>
          </template>
        </div>
    <ol v-else class="route-full-stops mt-4 grid gap-2" :aria-label="`路線 ${index + 1} 停靠順序`">
      <li v-for="stop in route.stops" :key="`${route.id}:${stop.sequence}`"
        class="flex min-w-0 flex-wrap items-start gap-3 rounded-lg border border-line p-3 sm:flex-nowrap"
        :class="rowClasses(stop.action)">
        <span class="route-list-stop-marker relative shrink-0" aria-hidden="true">
          <MapPin class="route-list-stop-pin" :style="{ color: stopPinColor(stop) }" :size="42"
            :stroke-width="1.75" />
          <span class="route-list-stop-number absolute grid place-items-center rounded-full font-mono font-bold text-black"
            :style="{ backgroundColor: stopPinColor(stop) }">{{ stop.sequence }}</span>
        </span>
        <button type="button" class="route-stop-button min-w-0 flex-1 text-left text-base leading-6 hover:underline"
          :aria-label="`查看第 ${stop.sequence} 站 ${stop.stationName} 詳情`"
          @click="emit('select', stop.stationId)">
          <strong class="block break-words text-ink">{{ stop.stationName }}</strong>
          <span class="block text-muted">{{ stop.district }}<template v-if="stop.sequence > 1"> · 上站起約 {{
            stop.distanceFromPreviousKm.toFixed(1) }} km</template></span>
        </button>
        <div
          class="flex w-full items-center justify-between gap-2 pl-11 text-base sm:w-auto sm:shrink-0 sm:flex-col sm:items-end sm:pl-0 sm:text-right">
          <span class="inline-flex items-center gap-2">
            <span class="inline-flex items-center gap-0.5" aria-hidden="true">
              <img v-if="stop.action !== 'pickup'" src="/animations/dropoff.svg" alt="" width="21" height="28"
                class="shrink-0" />
              <img v-if="stop.action !== 'dropoff'" src="/animations/pickup.svg" alt="" width="21" height="28"
                class="shrink-0" />
            </span>
            <span class="inline-flex px-2 py-1 font-bold" :class="actionClasses(stop.action)">{{
              actionLabel(stop.action) }}</span>
          </span>
          <small class="mt-1 block text-base text-muted">
            <template v-if="stop.dropoffBikes">卸車 {{ stop.dropoffBikes }}</template>
            <template v-if="stop.dropoffBikes && stop.pickupBikes">／</template>
            <template v-if="stop.pickupBikes">取車 {{ stop.pickupBikes }}</template>
            · 車載 {{ stop.vehicleLoadAfter }}
          </small>
        </div>
      </li>
    </ol>
      </div>
    </section>
    <p v-if="compact" class="route-capacity">最高車載 {{ route.peakVehicleLoad }} / {{ route.vehicleCapacity }} 台<span>{{ route.taskCount }} 筆搬運需求</span></p>
  </article>
</template>

<style scoped>
.route-preview { padding: 18px 20px 14px; }
.compact-route-title { display: flex; justify-content: space-between; align-items: center; gap: 12px; }
.compact-route-title h3 { font-size: 16px; font-weight: 650; }
.compact-route-title > span { font-size: 12px; color: var(--muted); }
.compact-route-title b { color: var(--warning); font-size: 13px; font-variant-numeric: tabular-nums; }
.compact-route-metrics { display: flex; align-items: center; flex-wrap: wrap; gap: 11px; padding: 11px 0 15px; }
.compact-route-metrics strong { font-size: 25px; line-height: 1.2; font-weight: 550; font-variant-numeric: tabular-nums; }
.compact-route-metrics small { font-size: 13px; font-weight: 400; color: var(--muted); margin-left: 5px; }
.route-metric-divider { height: 20px; width: 1px; background: var(--line); }
.route-estimate { font-size: 12px; color: var(--muted); margin-left: auto; }
.route-stops { border: 1px solid var(--line); border-radius: 8px; overflow: hidden; }
.route-stops .route-full-stops { margin-top: 0; padding: 12px; }
.route-endpoint { display: flex; width: 100%; align-items: center; gap: 11px; padding: 13px 12px; text-align: left; background: color-mix(in srgb, var(--panel-muted) 28%, var(--panel)); }
.route-endpoint + .route-endpoint { border-top: 1px dashed var(--line); }
.route-endpoint:hover { background: var(--panel-muted); }
.route-endpoint-gap { display: flex; align-items: center; gap: 11px; margin: 0; padding: 2px 12px; color: var(--muted); font-size: 12px; background: color-mix(in srgb, var(--panel-muted) 28%, var(--panel)); }
.route-endpoint-gap > span { width: 26px; text-align: center; font-size: 18px; line-height: 20px; }
.endpoint-content { min-width: 0; flex: 1; }
.endpoint-content small { display: block; color: var(--muted); font-size: 12px; line-height: 1.4; margin-bottom: 3px; }
.endpoint-content strong { display: block; font-size: 14px; font-weight: 550; line-height: 1.5; overflow-wrap: anywhere; }
.route-endpoint > svg { color: var(--muted); flex-shrink: 0; }
.route-capacity { display: flex; justify-content: space-between; gap: 10px; color: var(--muted); font-size: 12px; padding: 10px 0 5px; }
.route-expand { display: flex; width: 100%; min-height: 48px; align-items: center; justify-content: space-between; gap: 12px; padding: 12px; border-bottom: 1px solid var(--line); background: var(--panel-muted); color: var(--ink); text-align: left; }
.route-expand:hover { background: color-mix(in srgb, var(--accent) 10%, var(--panel)); }
.route-expand-title { font-size: 14px; font-weight: 650; }
.route-expand-title > span { font-weight: 400; color: var(--muted); }
.route-expand-action { display: inline-flex; align-items: center; gap: 8px; flex-shrink: 0; color: var(--accent); font-size: 13px; font-weight: 550; }
.route-expand-action > svg { transition: transform 160ms ease; }
.route-stop-button { min-height: 44px; }
.route-list-stop-marker { display: block; width: 42px; height: 42px; }
.route-list-stop-pin { display: block; width: 38px; height: 38px; }
.route-list-stop-number { top: 7px; left: calc(50% - 2px); width: 16px; height: 16px; transform: translateX(-50%); font-size: 10px; line-height: 1; white-space: nowrap; }
.route-expand:focus-visible, .route-endpoint:focus-visible, .route-stop-button:focus-visible { outline: 2px solid var(--accent); outline-offset: -3px; border-radius: 4px; }
@media (prefers-reduced-motion: reduce) { .route-expand-action > svg { transition: none; } }
</style>
