<script setup lang="ts">
import { EyeOff, MapPinned, Route } from '@lucide/vue'
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
watch(planning, (value) => {
  if (selectedRouteIndex.value >= value.routes.length) selectedRouteIndex.value = 0
})
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
  <section class="route-summary" aria-label="建議搬運路線">
    <div class="route-horizon-label"><span>調度需求時段</span><small>含較短時段需求</small></div>
    <div class="route-horizons" role="group" aria-label="調度需求時段">
      <button v-for="tab in TABS" :key="tab.key" type="button" :aria-pressed="activeTab === tab.key"
        :class="{ 'is-active': activeTab === tab.key }" @click="activeTab = tab.key">{{ tab.label }}</button>
    </div>
    <div v-if="planning.routes.length" class="route-selection-row">
      <div class="route-selector" role="group" aria-label="選擇建議路線">
        <button v-for="(item, routeIndex) in planning.routes" :key="item.id" type="button"
          :aria-pressed="selectedRouteIndex === routeIndex" :class="{ 'is-selected': selectedRouteIndex === routeIndex }"
          @click="selectedRouteIndex = routeIndex">路線 {{ routeIndex + 1 }}</button>
      </div>
    </div>
    <div v-if="visibleRoute">
      <RouteCard :key="`${activeTab}:${visibleRoute.id}`" :route="visibleRoute" :index="selectedRouteIndex" compact @select="emit('select', $event)" />
      <div class="observe-route-action">
        <button type="button" class="ops-button button-secondary" :class="{ 'is-observing': isObservingRoute }" :aria-pressed="isObservingRoute" @click="toggleObserveRoute">
          <component :is="isObservingRoute ? EyeOff : MapPinned" style="width: 1em; height: 1em" :stroke-width="2" aria-hidden="true" />{{ isObservingRoute ? '停止路線觀察' : '在地圖查看路線' }}<span v-if="isObservingRoute" class="observing-dot" />
        </button>
      </div>
    </div>
    <div v-else class="route-empty" role="status"><Route style="width: 1em; height: 1em" :stroke-width="2" aria-hidden="true" /><strong>目前沒有可行的搬運路線</strong><p>可切換時段，或前往站點總覽確認庫存風險。</p></div>
  </section>
</template>

<style scoped>
.route-horizon-label { display: flex; justify-content: space-between; gap: 10px; color: var(--muted); font-size: 13px; padding: 16px 20px 8px; }
.route-horizon-label small { font-size: 12px; }
.route-horizons { display: grid; grid-template-columns: repeat(3, 1fr); gap: 3px; border: 1px solid var(--line); border-radius: 7px; padding: 3px; margin: 0 20px; background: var(--canvas); }
.route-horizons button { min-height: 38px; padding: 7px; border-radius: 4px; font-size: 14px; color: var(--muted); font-weight: 500; }
.route-horizons button:hover { color: var(--ink); }
.route-horizons button.is-active { background: var(--panel-muted); color: var(--ink); box-shadow: 0 1px 3px #0002; }
.route-selection-row { padding: 16px 20px 0; }
.route-selector { display: flex; gap: 6px; overflow-x: auto; padding-bottom: 2px; }
.route-selector button { min-height: 40px; flex-shrink: 0; padding: 8px 10px; border: 1px solid var(--line); border-radius: 6px; font-size: 13px; color: var(--muted); }
.route-selector button:hover { border-color: var(--accent); }
.route-selector button.is-selected { color: var(--accent); background: color-mix(in srgb, var(--accent) 8%, var(--panel)); border-color: color-mix(in srgb, var(--accent) 60%, var(--line)); }
.observe-route-action { padding: 0 20px 12px; }
.observe-route-action .ops-button { width: 100%; }
.observe-route-action .is-observing { color: var(--accent); border-color: var(--accent); }
.observing-dot { display: inline-block; width: 6px; height: 6px; border-radius: 50%; background: var(--accent); }
.route-empty { display: grid; justify-items: center; gap: 8px; text-align: center; padding: 30px 22px; color: var(--muted); }
.route-empty > svg { font-size: 27px; }
.route-empty strong { font-size: 15px; font-weight: 550; color: var(--ink); }
.route-empty p { font-size: 13px; line-height: 1.6; }
</style>
