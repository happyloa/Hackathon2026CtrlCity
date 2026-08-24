<script setup lang="ts">
import { Icon } from '@iconify/vue'
import { buildDispatchRoutePlans } from '~/shared/dispatch-route-planner'
import type { DispatchRecommendation, StationRisk } from '~/shared/ops'

const props = defineProps<{
  dispatches: DispatchRecommendation[]
  stations: StationRisk[]
  compact?: boolean
  maxItems?: number
  embedded?: boolean
  contextQuery?: Record<string, string>
}>()

const emit = defineEmits<{ select: [stationId: string] }>()
const planning = computed(() => buildDispatchRoutePlans(props.dispatches, props.stations))
const visibleRoutes = computed(() => props.compact
  ? planning.value.routes.slice(0, props.maxItems || 1)
  : planning.value.routes)
const allRoutesTarget = computed(() => ({ path: '/dispatch', query: props.contextQuery || {} }))

function actionLabel(action: 'pickup' | 'dropoff' | 'mixed') {
  return { pickup: '取車', dropoff: '卸車', mixed: '卸車＋取車' }[action]
}

function actionClasses(action: 'pickup' | 'dropoff' | 'mixed') {
  if (action === 'pickup') return 'border-positive text-positive'
  if (action === 'dropoff') return 'border-accent text-accent'
  return 'border-info text-info'
}
</script>

<template>
  <section :class="embedded ? 'overflow-hidden border-0 bg-transparent shadow-none' : 'panel overflow-hidden'">
    <header v-if="!embedded" class="flex flex-col gap-3 border-b border-line p-4 sm:flex-row sm:items-start sm:justify-between">
      <div>
        <p class="section-kicker text-base"><Icon icon="solar:routing-2-outline" /> 多站物流規劃</p>
        <h2 class="m-0 mt-1 text-xl font-bold tracking-tight text-ink">{{ planning.routes.length }} 條啟發式建議路線</h2>
      </div>
      <NuxtLink v-if="compact" :to="allRoutesTarget" class="text-link min-h-11 text-base">查看規劃 <Icon icon="solar:arrow-right-up-outline" /></NuxtLink>
    </header>

    <div v-if="visibleRoutes.length" class="divide-y divide-line">
      <article v-for="(route, routeIndex) in visibleRoutes" :key="route.id" class="p-4">
        <div class="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div class="min-w-0">
            <span class="inline-flex items-center gap-2 text-base font-bold text-accent"><Icon icon="solar:streets-map-point-outline" /> 路線 {{ routeIndex + 1 }}</span>
            <h3 class="m-0 mt-1 text-lg font-bold text-ink">{{ route.stops.length }} 站 · {{ route.taskCount }} 筆需求 · 搬運 {{ route.totalTransferBikes }} 台</h3>
          </div>
          <div class="flex flex-wrap gap-2 text-base text-muted sm:justify-end">
            <span class="rounded-md border border-line bg-panel-muted px-2 py-1">約 {{ route.totalDistanceKm.toFixed(1) }} km</span>
            <span class="rounded-md border border-line bg-panel-muted px-2 py-1">載量 {{ route.peakVehicleLoad }}/{{ route.vehicleCapacity }}</span>
            <span class="rounded-md border border-line bg-panel-muted px-2 py-1">優先 {{ Math.round(route.highestPriorityScore) }}</span>
          </div>
        </div>

        <ol class="mt-4 grid gap-2" :aria-label="`路線 ${routeIndex + 1} 停靠順序`">
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

        <p class="m-0 mt-3 flex items-start gap-2 text-base leading-6 text-muted"><Icon class="mt-1 shrink-0 text-lg text-info" icon="solar:info-circle-outline" />{{ route.reasons[0] }}</p>
      </article>
    </div>
    <div v-else class="flex min-h-24 items-center justify-center gap-2 p-4 text-center text-base font-semibold text-positive"><Icon class="text-lg" icon="solar:check-circle-outline" />目前沒有可行的搬運路線。</div>

    <p v-if="planning.unplannedDispatches.length" class="m-0 border-t border-line bg-panel-muted p-4 text-base leading-6 text-muted"><Icon class="mr-1 inline text-warning" icon="solar:shield-warning-outline" />另有 {{ planning.unplannedDispatches.length }} 筆建議因容量、距離、座標或安全庫存限制未排入路線。</p>
  </section>
</template>
