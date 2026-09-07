<script setup lang="ts">
import { Icon } from '@iconify/vue'
import { buildDispatchRoutePlans, type DispatchRouteStop } from '~/shared/dispatch-route-planner'
import { buildLiveOperationsForHorizon, type DispatchHorizon } from '~/shared/live-operations'
import type { StationRisk } from '~/shared/ops'

const props = defineProps<{
  stations: StationRisk[]
  asOf: string
  contextQuery?: Record<string, string>
}>()

const emit = defineEmits<{ select: [stationId: string], observeRoute: [stops: DispatchRouteStop[] | null] }>()

const TABS: { key: DispatchHorizon; label: string }[] = [
  { key: 'now', label: '目前' },
  { key: '30', label: '30 分鐘' },
  { key: '60', label: '60 分鐘' },
]

const activeTab = defineModel<DispatchHorizon>({ default: 'now' })
const selectedRouteIndex = ref(0)
const isObservingRoute = ref(false)

// Every tab recomputes the full route from scratch: vehicle capacity is a hard
// limit, so appending a longer-horizon station to an already-planned route
// could produce an infeasible or badly ordered trip.
const planning = computed(() => {
  const dispatches = buildLiveOperationsForHorizon(props.stations, props.asOf, activeTab.value).dispatches
  return buildDispatchRoutePlans(dispatches, props.stations)
})
// A route picked in one tab has no meaning in another (different stations,
// different order), so switching tabs always comes back to the first route.
watch(activeTab, () => { selectedRouteIndex.value = 0 })
const visibleRoute = computed(() => planning.value.routes[selectedRouteIndex.value] ?? null)
const dispatchTarget = computed(() => ({ path: '/dispatch', query: props.contextQuery || {} }))

function toggleObserveRoute() {
  isObservingRoute.value = !isObservingRoute.value
}

// While observing, the map always mirrors whichever route is currently
// selected -- switching tabs or the route number updates the pins live
// instead of requiring the button to be pressed again.
watch([isObservingRoute, visibleRoute], ([observing, route]) => {
  emit('observeRoute', observing ? route?.stops ?? null : null)
})
onBeforeUnmount(() => { if (isObservingRoute.value) emit('observeRoute', null) })
</script>

<template>
  <section aria-labelledby="dispatch-route-summary-title">
    <div class="flex flex-wrap items-start gap-3 p-4 pb-2">
      <div class="min-w-0 flex-1">
        <strong id="dispatch-route-summary-title" class="block text-base text-ink">建議派遣路徑</strong>
      </div>
      <NuxtLink :to="dispatchTarget" class="text-link ml-auto min-h-11 text-base">立即調度
        <Icon icon="solar:arrow-right-up-outline" />
      </NuxtLink>
    </div>

    <div class="flex flex-wrap gap-2 px-4 pb-3" role="tablist" aria-label="預測視野">
      <button v-for="tab in TABS" :key="tab.key" type="button" role="tab" :aria-selected="activeTab === tab.key"
        class="min-h-9 rounded-md border px-3 text-base font-semibold transition-colors" :class="activeTab === tab.key
          ? 'border-accent-strong bg-accent text-on-accent'
          : 'border-line bg-panel-muted text-muted hover:border-accent-strong'" @click="activeTab = tab.key">
        {{ tab.label }}
      </button>
    </div>

    <div class="flex flex-wrap items-center justify-between gap-2 px-4 pb-3">
      <div v-if="planning.routes.length > 1" class="flex flex-wrap items-center gap-2">
        <span class="text-base text-muted">切換路線：</span>
        <button v-for="(route, routeIndex) in planning.routes" :key="route.id" type="button"
          :aria-selected="selectedRouteIndex === routeIndex" :aria-label="`路線 ${routeIndex + 1}`"
          class="grid size-8 shrink-0 place-items-center rounded-[4px] border font-mono text-base font-bold transition-colors"
          :class="selectedRouteIndex === routeIndex
            ? 'border-orange-400 bg-orange-300 text-on-accent'
            : 'border-line bg-panel-muted text-muted hover:border-orange-300'"
          @click="selectedRouteIndex = routeIndex">
          {{ routeIndex + 1 }}
        </button>
      </div>
      <div v-else aria-hidden="true" />
      <button type="button" :aria-pressed="isObservingRoute" :disabled="!visibleRoute"
        class="inline-flex min-h-9 shrink-0 items-center gap-1.5 rounded-md border px-3 text-base font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50"
        :class="isObservingRoute
          ? 'border-accent-strong bg-accent text-on-accent'
          : 'border-line bg-panel-muted text-muted hover:border-accent-strong'"
        @click="toggleObserveRoute">
        <Icon class="text-lg" :icon="isObservingRoute ? 'solar:eye-bold' : 'solar:eye-outline'" /> 路線觀察
      </button>
    </div>

    <div v-if="visibleRoute" class="divide-y divide-line border-t border-line">
      <RouteCard :route="visibleRoute" :index="selectedRouteIndex" @select="emit('select', $event)" />
    </div>
    <div v-else
      class="flex min-h-24 items-center justify-center gap-2 border-t border-line p-4 text-center text-base font-semibold text-positive">
      <Icon class="text-lg" icon="solar:check-circle-outline" />這個視野目前沒有可行的搬運路線。
    </div>
  </section>
</template>
