<script setup lang="ts">
import { Icon } from '@iconify/vue'
import type { DispatchRoutePlan, DispatchRouteStopAction } from '~/shared/dispatch-route-planner'

defineProps<{
  route: DispatchRoutePlan
  /** Zero-based position, used only for the "路線 N" label. */
  index: number
}>()

const emit = defineEmits<{ select: [stationId: string] }>()

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
</script>

<template>
  <article class="p-4">
    <div class="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
      <div class="min-w-0">
        <span class="inline-flex items-center gap-2 text-base font-bold text-accent">
          <Icon icon="solar:streets-map-point-outline" /> 路線 {{ index + 1 }}
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

    <ol class="mt-4 grid gap-2" :aria-label="`路線 ${index + 1} 停靠順序`">
      <li v-for="stop in route.stops" :key="`${route.id}:${stop.sequence}`"
        class="flex min-w-0 flex-wrap items-start gap-3 rounded-lg border border-line p-3 sm:flex-nowrap"
        :class="rowClasses(stop.action)">
        <span
          class="grid size-8 shrink-0 place-items-center rounded-full bg-accent font-mono text-base font-bold text-on-accent">{{
            stop.sequence }}</span>
        <button type="button" class="min-w-0 flex-1 text-left text-base leading-6 hover:underline"
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
  </article>
</template>
