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
  if (action === 'pickup') return 'border-positive text-positive'
  if (action === 'dropoff') return 'border-accent text-accent'
  return 'border-info text-info'
}
</script>

<template>
  <article class="p-4">
    <div class="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
      <div class="min-w-0">
        <span class="inline-flex items-center gap-2 text-base font-bold text-accent"><Icon icon="solar:streets-map-point-outline" /> 路線 {{ index + 1 }}</span>
        <h3 class="m-0 mt-1 text-lg font-bold text-ink">{{ route.stops.length }} 站 · 搬運 {{ route.totalTransferBikes }} 台</h3>
      </div>
      <div class="flex flex-wrap gap-2 text-base text-muted sm:justify-end">
        <span class="rounded-md border border-line bg-panel-muted px-2 py-1">約 {{ route.totalDistanceKm.toFixed(1) }} km</span>
        <span class="rounded-md border border-line bg-panel-muted px-2 py-1">載量 {{ route.peakVehicleLoad }}/{{ route.vehicleCapacity }}</span>
        <span class="rounded-md border border-line bg-panel-muted px-2 py-1">{{ route.taskCount }} 筆需求 · 優先 {{ Math.round(route.highestPriorityScore) }}</span>
      </div>
    </div>

    <ol class="mt-4 grid gap-2" :aria-label="`路線 ${index + 1} 停靠順序`">
      <li v-for="stop in route.stops" :key="`${route.id}:${stop.sequence}`" class="flex min-w-0 flex-wrap items-start gap-3 rounded-lg border border-line bg-panel-muted p-3 sm:flex-nowrap">
        <span class="grid size-8 shrink-0 place-items-center rounded-full bg-accent font-mono text-base font-bold text-on-accent">{{ stop.sequence }}</span>
        <button type="button" class="min-w-0 flex-1 text-left text-base leading-6 hover:underline" @click="emit('select', stop.stationId)">
          <strong class="block break-words text-ink">{{ stop.stationName }}</strong>
          <span class="block text-muted">{{ stop.district }}<template v-if="stop.sequence > 1"> · 上站起約 {{ stop.distanceFromPreviousKm.toFixed(1) }} km</template></span>
        </button>
        <div class="flex w-full items-center justify-between gap-2 pl-11 text-base sm:w-auto sm:shrink-0 sm:flex-col sm:items-end sm:pl-0 sm:text-right">
          <span class="inline-flex rounded-md border bg-panel px-2 py-1 font-bold" :class="actionClasses(stop.action)">{{ actionLabel(stop.action) }}</span>
          <small class="mt-1 block text-base text-muted">
            <template v-if="stop.dropoffBikes">卸 {{ stop.dropoffBikes }}</template>
            <template v-if="stop.dropoffBikes && stop.pickupBikes">／</template>
            <template v-if="stop.pickupBikes">取 {{ stop.pickupBikes }}</template>
            · 載 {{ stop.vehicleLoadAfter }}
          </small>
        </div>
      </li>
    </ol>
  </article>
</template>
