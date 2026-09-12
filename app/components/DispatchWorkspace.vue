<script setup lang="ts">
import { ArrowDownUp, ArrowRight, Bike, ChevronDown, ChevronLeft, ChevronRight, CircleCheck, Info, LoaderCircle, MapPinned, RefreshCw, Route as RouteIcon, ShieldCheck, TriangleAlert, Truck } from '@lucide/vue'
import { buildDispatchRoutePlans, DEFAULT_DISPATCH_ROUTE_POLICY, type DispatchRoutePlan } from '~/shared/dispatch-route-planner'
import { buildLiveOperationsForHorizon, type DispatchHorizon } from '~/shared/live-operations'
import {
  applyManualRouteEffects,
  horizonBucketFor,
  minutesUntilScheduledTime,
  recomputeManualRoute,
  taipeiTimeLabel,
  toDispatchRoutePlanShape,
} from '~/shared/manual-route-planner'

type RouteChoice = { plan: DispatchRoutePlan; number: number; key: string; isManual: boolean; manualRouteId?: string; manualLabel?: string }

const route = useRoute()
const router = useRouter()
const live = useLiveDashboard()
const { selectedDistrict, selectionSource, locationMessage, syncDistrictFromContext } = useDistrictSelection({
  stations: () => live.dashboard.value?.stations,
  districts: () => live.dashboard.value?.districts,
  initialDistrict: () => typeof route.query.district === 'string' ? route.query.district : '',
})
// The shared layout owns polling; each horizon reruns the capacity-safe planner.
const activeHorizon = ref<DispatchHorizon>('60')
const horizons: { key: DispatchHorizon; label: string }[] = [
  { key: 'now', label: '目前' }, { key: '30', label: '30 分鐘' }, { key: '60', label: '60 分鐘' },
]
const sortOrder = ref<'priority' | 'bikes' | 'distance'>('priority')
const selectedRouteKey = ref('')
const selectedSequence = ref<number | null>(null)
const inspectedStationId = ref('')
const manualInspectedStationId = ref('')
const routePage = ref(0)
const pageSize = 3
const dashboard = computed(() => live.dashboardForDistrict(selectedDistrict.value))
const manualRoutesApi = useManualRoutes()

/**
 * The full, unfiltered station list -- manual routes are user-authored
 * artifacts independent of whatever district the comparison view happens to
 * be scoped to right now, and can span stations in more than one district.
 * Resolving their stops against the district-filtered `dashboard.stations`
 * instead would make a route's own stations silently disappear ("站點資料
 * 不存在或目前離線") the moment the district filter changes -- e.g. after a
 * reload re-picks a district by geolocation -- even though the route's data
 * is intact in its configured storage the whole time.
 */
const allStations = computed(() => live.dashboard.value?.stations ?? [])

/**
 * Recomputed against the full station list (see `allStations` above), each
 * against whichever forecast horizon its own `scheduledAt` falls into -- so
 * a route scheduled further out is judged against predicted, not current, inventory.
 */
const manualPlans = computed(() => {
  const stations = allStations.value
  const asOf = dashboard.value?.meta.asOf ?? new Date().toISOString()
  return manualRoutesApi.routes.value.map((route) => {
    const horizon = horizonBucketFor(minutesUntilScheduledTime(route.scheduledAt, asOf))
    return recomputeManualRoute(route, stations, horizon)
  })
})
/**
 * Stations as the auto planner should see them: nets out every manual route
 * scheduled at or before `activeHorizon`, so it never re-suggests bikes an
 * operator has already manually routed away (or in).
 */
const adjustedStations = computed(() => (dashboard.value
  ? applyManualRouteEffects(dashboard.value.stations, manualPlans.value, activeHorizon.value)
  : []))
const planning = computed(() => {
  if (!dashboard.value) return { routes: [], unplannedDispatches: [] }
  const operations = buildLiveOperationsForHorizon(adjustedStations.value, dashboard.value.meta.asOf, activeHorizon.value)
  return buildDispatchRoutePlans(operations.dispatches, adjustedStations.value)
})
const manualChoices = computed<RouteChoice[]>(() => manualPlans.value
  .filter(plan => plan.stops.length > 0)
  .map(plan => ({ plan: toDispatchRoutePlanShape(plan), number: -1, key: `manual:${plan.id}`, isManual: true, manualRouteId: plan.id, manualLabel: plan.label })))
const choices = computed<RouteChoice[]>(() => {
  const occurrences = new Map<string, number>()
  const autoChoices: RouteChoice[] = planning.value.routes.map((plan, index) => {
    // Snapshot timestamps change route ids. Track the station order to preserve selection on refresh.
    const shape = JSON.stringify(plan.stops.map(stop => [stop.stationId, stop.action]))
    const occurrence = occurrences.get(shape) || 0
    occurrences.set(shape, occurrence + 1)
    return { plan, number: index + 1, key: `${shape}:${occurrence}`, isManual: false }
  })
  const compare = (left: RouteChoice, right: RouteChoice) => {
    if (sortOrder.value === 'bikes') return right.plan.totalTransferBikes - left.plan.totalTransferBikes || left.number - right.number
    if (sortOrder.value === 'distance') return left.plan.totalDistanceKm - right.plan.totalDistanceKm || left.number - right.number
    return right.plan.highestPriorityScore - left.plan.highestPriorityScore || left.number - right.number
  }
  // Manual routes always lead, regardless of sort order -- they're the
  // operator's own routes, not suggestions to rank against the model's score.
  return [...manualChoices.value.sort(compare), ...autoChoices.sort(compare)]
})
const selectedChoice = computed(() => choices.value.find(item => item.key === selectedRouteKey.value) ?? choices.value[0] ?? null)
const pageCount = computed(() => Math.ceil(choices.value.length / pageSize))
const visibleChoices = computed(() => choices.value.slice(routePage.value * pageSize, (routePage.value + 1) * pageSize))
const totals = computed(() => choices.value.reduce((sum, choice) => ({
  bikes: sum.bikes + choice.plan.totalTransferBikes, tasks: sum.tasks + choice.plan.taskCount, distance: sum.distance + choice.plan.totalDistanceKm,
}), { bikes: 0, tasks: 0, distance: 0 }))
const inspectedStation = computed(() => allStations.value.find(station => station.id === inspectedStationId.value) ?? null)
const manualInspectedStation = computed(() => allStations.value.find(station => station.id === manualInspectedStationId.value) ?? null)
const contextQuery = computed<Record<string, string>>(() => {
  const query: Record<string, string> = {}
  if (selectedDistrict.value) query.district = selectedDistrict.value
  return query
})
const districtPickerOptions = computed(() => [
  { value: '', label: '全部行政區' },
  ...(live.dashboard.value?.districts || []).map(district => ({ value: district, label: district })),
])
const asOfLabel = computed(() => dashboard.value ? new Intl.DateTimeFormat('zh-TW', {
  month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
}).format(new Date(dashboard.value.meta.asOf)) : '尚未載入')
const forecastAvailable = computed(() => activeHorizon.value === 'now' || dashboard.value?.stations.some(station =>
  station.serviceStatus === 'operational' && station.forecast.horizons[activeHorizon.value === '30' ? '30' : '60'].baselineStatus === 'matched'))

watch(selectedDistrict, (district) => {
  if (!import.meta.client) return
  const current = typeof route.query.district === 'string' ? route.query.district : ''
  if (district !== current) void router.replace({ query: district ? { district } : {} })
}, { immediate: true })
watch(() => route.query.district, district => syncDistrictFromContext(typeof district === 'string' ? district : ''))
watch([activeHorizon, selectedDistrict], () => {
  selectedRouteKey.value = ''
  selectedSequence.value = null
  inspectedStationId.value = ''
  routePage.value = 0
})
watch(choices, (items) => {
  routePage.value = Math.min(routePage.value, Math.max(0, Math.ceil(items.length / pageSize) - 1))
  if (!items.some(item => item.key === selectedRouteKey.value)) {
    selectedRouteKey.value = items[0]?.key || ''
    selectedSequence.value = null
    inspectedStationId.value = ''
  }
}, { immediate: true })
watch(sortOrder, () => {
  const index = choices.value.findIndex(item => item.key === selectedChoice.value?.key)
  routePage.value = Math.max(0, Math.floor(index / pageSize))
})
watch(dashboard, () => { if (inspectedStationId.value && !inspectedStation.value) inspectedStationId.value = '' })
function selectRoute(key: string) {
  if (selectedChoice.value?.key === key) return
  selectedRouteKey.value = key
  selectedSequence.value = null
  inspectedStationId.value = ''
}
function goToRoutePage(delta: number) {
  const nextPage = Math.max(0, Math.min(pageCount.value - 1, routePage.value + delta))
  if (nextPage === routePage.value) return
  routePage.value = nextPage
  const nextChoice = choices.value[nextPage * pageSize]
  if (nextChoice) selectRoute(nextChoice.key)
}
function selectStop(sequence: number) {
  selectedSequence.value = sequence
  inspectedStationId.value = ''
}

const HORIZON_MINUTES: Record<DispatchHorizon, number> = { now: 0, '30': 30, '60': 60 }

/**
 * Turns the selected route into an editable manual one: an auto-generated
 * route is forked into a new manual route seeded with its current stops
 * (scheduled at "now + this horizon", the operator's own routes just jump
 * straight to editing), then focuses the manual editor on it.
 */
async function handleEditRoute() {
  const choice = selectedChoice.value
  if (!choice) return
  let routeId: string
  if (choice.isManual && choice.manualRouteId) {
    routeId = choice.manualRouteId
  } else {
    const scheduledAt = taipeiTimeLabel(Date.now() + HORIZON_MINUTES[activeHorizon.value] * 60_000)
    if (!manualRoutesApi.cloud.canEdit.value) {
      manualRoutesApi.editorExpanded.value = true
      document.getElementById('manual-route-editor')?.scrollIntoView({ behavior: 'smooth' })
      return
    }
    const route = manualRoutesApi.createRoute({
      label: `路線 ${String(choice.number).padStart(2, '0')} 編輯版`,
      vehicleCapacity: choice.plan.vehicleCapacity,
      scheduledAt,
      stops: choice.plan.stops.map(stop => ({ stationId: stop.stationId, pickupBikes: stop.pickupBikes, dropoffBikes: stop.dropoffBikes })),
    })
    routeId = route.id
  }
  manualRoutesApi.focusRoute(routeId)

  // Manual routes always sort first (see `choices`), but jump the comparison
  // list's own selection/page to it too, so the just-created/forked route is
  // what's actually shown in the map and flow, not whatever was selected before.
  await nextTick()
  const key = `manual:${routeId}`
  const index = choices.value.findIndex(item => item.key === key)
  if (index !== -1) {
    selectedRouteKey.value = key
    selectedSequence.value = null
    inspectedStationId.value = ''
    routePage.value = Math.floor(index / pageSize)
  }
  void nextTick(() => document.getElementById('manual-route-editor')?.scrollIntoView({ block: 'start', behavior: 'smooth' }))
}
</script>

<template>
  <div class="dispatch-page">
    <section class="dispatch-filters" aria-label="調度範圍與時段">
      <div class="dispatch-district"><ModalPicker v-model="selectedDistrict" :label="selectionSource === 'location' ? '行政區（依位置）' : '行政區'" title="選擇行政區" :options="districtPickerOptions" /></div>
      <div class="dispatch-horizon"><span>需求時段<small>含較短時段需求</small></span><div role="group" aria-label="調度需求時段"><button v-for="horizon in horizons" :key="horizon.key" type="button" :aria-pressed="activeHorizon === horizon.key" :class="{ 'is-active': activeHorizon === horizon.key }" @click="activeHorizon = horizon.key">{{ horizon.label }}</button></div></div>
      <div class="dispatch-source"><span><i :class="{ 'is-stale': live.error.value }" />{{ live.error.value ? '更新暫時中斷' : '官方即時資料' }}<time>{{ asOfLabel }}</time></span><button type="button" class="dispatch-button" :disabled="live.pending.value" @click="live.refresh({ manual: true })"><LoaderCircle v-if="live.pending.value" :size="16" class="dispatch-spin" aria-hidden="true" /><RefreshCw v-else :size="16" aria-hidden="true" />{{ live.pending.value ? '更新中' : '更新資料' }}</button></div>
      <span class="sr-only" role="status" aria-live="polite">{{ locationMessage }}</span>
    </section>
    <div v-if="live.pending.value && !dashboard" class="loading-board" role="status" aria-busy="true"><LoaderCircle :size="22" class="dispatch-spin" aria-hidden="true" />正在建立即時路線建議…</div>
    <div v-else-if="live.error.value && !dashboard" class="loading-board error-board" role="alert"><TriangleAlert :size="22" aria-hidden="true" />{{ live.error.value }}<PageRetryButton :busy="live.pending.value" @retry="live.refresh({ manual: true })" /></div>
    <template v-else-if="dashboard">
      <p v-if="live.error.value" class="dispatch-notice" role="alert"><TriangleAlert :size="17" aria-hidden="true" />目前顯示上一筆成功載入的資料。{{ live.error.value }}</p>
      <p v-if="!forecastAvailable" class="dispatch-notice" role="status"><Info :size="17" aria-hidden="true" />此時段的預測暫不可用，目前路線僅依即時庫存建立。</p>
      <section class="dispatch-totals" aria-label="調度效率概覽">
        <div><RouteIcon :size="21" aria-hidden="true" /><span><small>可行路線</small><strong>{{ choices.length }}<em>條</em></strong></span><p>{{ totals.tasks }} 筆搬運需求</p></div>
        <div><Bike :size="21" aria-hidden="true" /><span><small>建議搬運總量</small><strong>{{ totals.bikes }}<em>台</em></strong></span><p>各路線搬運量加總</p></div>
        <div><MapPinned :size="21" aria-hidden="true" /><span><small>總站間估距</small><strong>{{ totals.distance.toFixed(1) }}<em>km</em></strong></span><p>依站點直線距離</p></div>
      </section>
      <template v-if="selectedChoice">
        <section class="dispatch-comparison" aria-label="比較並選擇路線">
          <header><div><h3>路線比較</h3><p>選擇路線，查看站序與地圖</p></div><div class="dispatch-comparison-controls"><label class="dispatch-sort"><ArrowDownUp :size="15" aria-hidden="true" /><select v-model="sortOrder" aria-label="路線排序"><option value="priority">優先分數高到低</option><option value="bikes">搬運量多到少</option><option value="distance">站間估距短到長</option></select></label><div v-if="pageCount > 1" class="dispatch-pagination"><button type="button" aria-label="上一頁路線" :disabled="routePage === 0" @click="goToRoutePage(-1)"><ChevronLeft :size="18" aria-hidden="true" /></button><span>{{ routePage + 1 }} / {{ pageCount }}</span><button type="button" aria-label="下一頁路線" :disabled="routePage + 1 >= pageCount" @click="goToRoutePage(1)"><ChevronRight :size="18" aria-hidden="true" /></button></div></div></header>
          <div class="dispatch-route-cards" role="group" aria-label="選擇路線">
            <button v-for="choice in visibleChoices" :key="choice.key" type="button" class="dispatch-route-choice" :class="{ 'is-selected': selectedChoice.key === choice.key }" :aria-pressed="selectedChoice.key === choice.key" @click="selectRoute(choice.key)">
              <span class="dispatch-choice-top"><span class="dispatch-choice-title"><b>{{ choice.isManual ? choice.manualLabel : `路線 ${String(choice.number).padStart(2, '0')}` }}</b><span v-if="choice.isManual" class="dispatch-manual-badge">手動</span></span><span v-if="selectedChoice.key === choice.key" class="dispatch-selected-label"><CircleCheck :size="15" aria-hidden="true" />檢視中</span><span v-else-if="!choice.isManual" class="dispatch-choice-score">優先 {{ Math.round(choice.plan.highestPriorityScore) }}</span></span>
              <span class="dispatch-choice-numbers"><strong>{{ choice.plan.totalTransferBikes }}<small>台搬運</small></strong><span>{{ choice.plan.stops.length }} 站<span class="dispatch-choice-dot">·</span>{{ choice.plan.totalDistanceKm.toFixed(1) }} km</span></span>
              <span class="dispatch-choice-load"><span><Truck :size="14" aria-hidden="true" />最高車載 {{ choice.plan.peakVehicleLoad }} / {{ choice.plan.vehicleCapacity }}</span><span>{{ choice.plan.taskCount }} 筆需求</span></span>
              <span class="dispatch-load-track" aria-hidden="true"><i :style="{ width: `${Math.min(100, choice.plan.peakVehicleLoad / choice.plan.vehicleCapacity * 100)}%` }" /></span>
            </button>
          </div>
        </section>
        <section class="dispatch-workspace" aria-label="所選路線的地圖與停靠順序">
          <ClientOnly><DispatchRouteMap :route="selectedChoice.plan" :route-number="selectedChoice.number" :stations="allStations" :selected-sequence="selectedSequence" @select-stop="selectStop" /><template #fallback><div class="dispatch-map-placeholder loading-board"><LoaderCircle :size="22" class="dispatch-spin" aria-hidden="true" />正在載入路線地圖…</div></template></ClientOnly>
          <div class="dispatch-flow-column" :class="{ 'is-inspecting': inspectedStation }">
            <DispatchRouteFlow :route="selectedChoice.plan" :route-number="selectedChoice.number" :stations="allStations" :is-manual="selectedChoice.isManual" :label-override="selectedChoice.manualLabel" :selected-sequence="selectedSequence" @select-stop="selectStop" @inspect-station="inspectedStationId = $event" @edit-route="handleEditRoute" />
            <StationDetailPanel docked :station="inspectedStation" :stations="allStations" :history="[]" :horizon="activeHorizon === 'now' ? '30' : activeHorizon" data-mode="live" :context-query="contextQuery" @close="inspectedStationId = ''" @select="inspectedStationId = $event" />
          </div>
        </section>
      </template>
      <section v-else class="dispatch-empty" role="status"><RouteIcon :size="32" aria-hidden="true" /><h3>目前沒有可行的搬運路線</h3><p>可切換需求時段或行政區，查看其他調度需求。</p><NuxtLink :to="{ path: '/stations', query: contextQuery }" class="dispatch-button">查看站點庫存<ArrowRight :size="16" aria-hidden="true" /></NuxtLink></section>
      <details v-if="planning.unplannedDispatches.length" class="dispatch-unplanned"><summary><span><TriangleAlert :size="17" aria-hidden="true" />{{ planning.unplannedDispatches.length }} 筆需求未排入路線</span><span>查看原因<ChevronDown :size="16" aria-hidden="true" /></span></summary><ul><li v-for="item in planning.unplannedDispatches" :key="`${item.dispatchId}:${item.code}`">{{ item.reason }}</li></ul></details>
      <ManualRouteEditor :stations="allStations" :as-of="dashboard.meta.asOf" @select="manualInspectedStationId = $event" />
      <StationDetailPanel v-if="manualInspectedStationId" docked :station="manualInspectedStation" :stations="allStations" :history="[]" horizon="60" data-mode="live" :context-query="contextQuery" @close="manualInspectedStationId = ''" @select="manualInspectedStationId = $event" />
      <footer class="dispatch-footnote"><span><Info :size="14" aria-hidden="true" />路線為調度建議，尚未派發</span><span><ShieldCheck :size="14" aria-hidden="true" />高風險優先 · 每車 {{ DEFAULT_DISPATCH_ROUTE_POLICY.vehicleCapacity }} 台 · {{ DEFAULT_DISPATCH_ROUTE_POLICY.maximumAdjacentTaskDistanceKm }} km 內整併</span></footer>
    </template>
  </div>
</template>

<style scoped>
.dispatch-page { --dispatch-workspace-height: 720px; --dispatch-pickup: #7dd3fc; --dispatch-dropoff: #ff6f61; --dispatch-mixed: #f4cc79; max-width: 1760px; margin: auto; padding: 20px 32px 28px; display: grid; gap: 16px; }
/* Grid items default to min-width:auto, which lets the min-content of the
   route rail (fixed-width cards behind an overflow-x scroller) widen the
   whole column and scroll the page sideways on a phone. */
.dispatch-page > * { min-width: 0; }
.dispatch-heading, .dispatch-source, .dispatch-source > span, .dispatch-button, .dispatch-policy, .dispatch-comparison > header, .dispatch-comparison-controls, .dispatch-sort, .dispatch-pagination, .dispatch-choice-top, .dispatch-choice-load, .dispatch-choice-load > span, .dispatch-choice-numbers, .dispatch-selected-label, .dispatch-footnote, .dispatch-footnote > span { display: flex; align-items: center; }
.dispatch-heading { justify-content: space-between; gap: 16px; }
.dispatch-eyebrow { display: flex; align-items: center; gap: 7px; color: var(--accent); font-size: var(--type-body2); font-weight: 650; margin-bottom: 6px; }
.dispatch-heading h2 { font-size: var(--type-h5); line-height: 1.4; font-weight: 650; letter-spacing: -.025em; }
.dispatch-source { margin-left: auto; min-height: 44px; gap: 16px; font-size: var(--type-body2); color: var(--muted); flex-wrap: wrap; justify-content: end; }
.dispatch-source > span { gap: 7px; flex-wrap: wrap; }.dispatch-source i { width: 6px; height: 6px; border-radius: 50%; background: var(--accent); }.dispatch-source i.is-stale { background: var(--warning); }.dispatch-source time { margin-left: 4px; font-variant-numeric: tabular-nums; }
.dispatch-button { justify-content: center; gap: 7px; min-height: 44px; padding: 8px 12px; border: 1px solid var(--line); background: var(--panel); border-radius: 7px; color: var(--ink); font-size: var(--type-body2); font-weight: 550; text-decoration: none; }.dispatch-button:hover { border-color: var(--accent); }
.dispatch-filters { display: flex; align-items: end; flex-wrap: wrap; gap: 24px; border-bottom: 1px solid var(--line); padding-bottom: 20px; }.dispatch-district { width: 215px; }.dispatch-district :deep(> div > span) { font-size: var(--type-body2); font-weight: 500; }.dispatch-district :deep(button) { font-size: var(--type-body2); min-height: 44px; }
.dispatch-horizon > span { display: flex; gap: 10px; color: var(--muted); font-size: var(--type-body2); margin-bottom: 7px; }.dispatch-horizon small { font-size: var(--type-body2); color: var(--muted); opacity: .8; }.dispatch-horizon > div { display: flex; padding: 3px; border: 1px solid var(--line); background: var(--panel); border-radius: 8px; }.dispatch-horizon button { min-height: 36px; padding: 7px 18px; border-radius: 5px; font-size: var(--type-body2); color: var(--muted); }.dispatch-horizon button.is-active { color: var(--on-accent); background: var(--accent); font-weight: 650; }
.dispatch-policy { gap: 9px; color: var(--muted); margin-left: auto; font-size: var(--type-body2); min-height: 44px; }.dispatch-policy > svg { color: var(--accent); }.dispatch-policy b { color: var(--ink); font-weight: 600; }.dispatch-policy small { display: block; font-size: var(--type-body2); line-height: 1.6; }
.dispatch-totals { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); border: 1px solid var(--line); background: var(--panel); border-radius: 10px; padding: 18px 0; }.dispatch-totals > div { display: flex; align-items: center; gap: 14px; padding: 0 22px; min-width: 0; }.dispatch-totals > div + div { border-left: 1px solid var(--line); }.dispatch-totals svg { color: var(--muted); flex-shrink: 0; }.dispatch-totals small { display: block; font-size: var(--type-body2); color: var(--muted); line-height: 1.5; }.dispatch-totals strong { display: block; font-size: var(--type-h4); font-weight: 600; letter-spacing: -.035em; line-height: 1.3; font-variant-numeric: tabular-nums; }.dispatch-totals em { font-size: var(--type-body2); font-style: normal; font-weight: 400; color: var(--muted); margin-left: 7px; letter-spacing: 0; }.dispatch-totals p { margin-left: auto; align-self: end; margin-bottom: 4px; font-size: var(--type-body2); color: var(--muted); text-align: right; }
.dispatch-comparison > header { justify-content: space-between; gap: 12px; margin-bottom: 12px; }.dispatch-comparison h3 { font-size: var(--type-body1); font-weight: 650; }.dispatch-comparison header p { font-size: var(--type-body2); color: var(--muted); margin-top: 2px; }.dispatch-comparison-controls { gap: 14px; }.dispatch-sort { gap: 7px; color: var(--muted); }.dispatch-sort select { padding: 9px 5px; min-height: 44px; font-size: var(--type-body2); color: var(--ink); background: var(--canvas); border-radius: 4px; }.dispatch-sort select:focus-visible { outline: 2px solid var(--accent); }
.dispatch-pagination { gap: 7px; color: var(--muted); font-size: var(--type-body2); font-variant-numeric: tabular-nums; }.dispatch-pagination button { display: grid; place-items: center; width: 36px; height: 44px; border: 1px solid var(--line); background: var(--panel); border-radius: 6px; }.dispatch-pagination button:hover:not(:disabled) { border-color: var(--accent); color: var(--ink); }
.dispatch-route-cards { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; }.dispatch-route-choice { min-width: 0; padding: 14px 16px; border: 1px solid var(--line); border-radius: 9px; background: var(--panel); text-align: left; transition: border-color 150ms, background 150ms; }.dispatch-route-choice:hover { border-color: var(--accent); }.dispatch-route-choice.is-selected { background: color-mix(in srgb, var(--accent) 7%, var(--panel)); border-color: var(--accent); box-shadow: inset 3px 0 0 var(--accent); }
.dispatch-choice-top { justify-content: space-between; gap: 8px; }.dispatch-choice-title { display: flex; align-items: center; gap: 7px; min-width: 0; }.dispatch-choice-title > b { font-size: var(--type-body1); font-weight: 650; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }.dispatch-choice-score { font-size: var(--type-body2); color: var(--muted); white-space: nowrap; }.dispatch-selected-label { color: var(--accent); font-size: var(--type-body2); gap: 5px; white-space: nowrap; }.dispatch-manual-badge { padding: 2px 7px; border-radius: 5px; background: color-mix(in srgb, var(--accent) 15%, transparent); color: var(--accent); font-size: var(--type-body2); font-weight: 550; white-space: nowrap; }
.dispatch-choice-numbers { justify-content: space-between; gap: 8px; margin: 12px 0; }.dispatch-choice-numbers strong { font-size: var(--type-h5); font-weight: 600; line-height: 1.2; font-variant-numeric: tabular-nums; }.dispatch-choice-numbers strong small { font-size: var(--type-body2); color: var(--muted); font-weight: 400; margin-left: 5px; }.dispatch-choice-numbers > span { font-size: var(--type-body2); color: var(--muted); }.dispatch-choice-dot { padding: 0 7px; color: var(--line-strong); }
.dispatch-choice-load { justify-content: space-between; gap: 6px; font-size: var(--type-body2); color: var(--muted); }.dispatch-choice-load > span { gap: 5px; }.dispatch-load-track { height: 3px; background: var(--line); border-radius: 3px; margin-top: 7px; display: block; overflow: hidden; }.dispatch-load-track i { height: 100%; display: block; background: var(--accent); opacity: .5; }.is-selected .dispatch-load-track i { opacity: 1; }
.dispatch-workspace { display: grid; grid-template-columns: minmax(0, 1.2fr) minmax(360px, .8fr); gap: 18px; align-items: start; }.dispatch-workspace > * { min-width: 0; }.dispatch-map-placeholder { height: 620px; }
.dispatch-footnote { justify-content: space-between; flex-wrap: wrap; gap: 8px; font-size: var(--type-body2); color: var(--muted); }.dispatch-footnote > span { gap: 6px; }.dispatch-notice { display: flex; align-items: start; gap: 8px; padding: 12px 14px; border: 1px solid color-mix(in srgb, var(--warning) 40%, var(--line)); border-radius: 8px; color: var(--warning); font-size: var(--type-body2); }.dispatch-notice > svg { flex-shrink: 0; margin-top: 3px; }
.dispatch-unplanned { border: 1px solid var(--line); border-radius: 8px; background: var(--panel); }.dispatch-unplanned summary { list-style: none; display: flex; justify-content: space-between; align-items: center; gap: 12px; padding: 12px 16px; min-height: 48px; cursor: pointer; font-size: var(--type-body2); }.dispatch-unplanned summary::-webkit-details-marker { display: none; }.dispatch-unplanned summary > span { display: flex; align-items: center; gap: 7px; }.dispatch-unplanned summary > span:first-child { color: var(--warning); }.dispatch-unplanned summary > span:last-child { color: var(--muted); }.dispatch-unplanned[open] summary > span:last-child svg { transform: rotate(180deg); }.dispatch-unplanned ul { border-top: 1px solid var(--line); margin: 0; padding: 12px 20px 16px 36px; list-style: disc; color: var(--muted); font-size: var(--type-body2); }
.dispatch-empty { display: grid; justify-items: center; gap: 12px; padding: 56px 20px; border: 1px solid var(--line); border-radius: 10px; background: var(--panel); text-align: center; }.dispatch-empty > svg { color: var(--accent); }.dispatch-empty h3 { font-size: var(--type-h6); font-weight: 600; }.dispatch-empty p { font-size: var(--type-body2); color: var(--muted); }.dispatch-empty .dispatch-button { margin-top: 6px; }
.dispatch-spin { animation: dispatch-spin 1s linear infinite; }@keyframes dispatch-spin { to { transform: rotate(360deg); } }
@media (min-width: 1101px) { .dispatch-flow-column.is-inspecting > :first-child { display: none; } }
@media (max-width: 1350px) { .dispatch-totals p { display: none; }.dispatch-totals > div { padding: 0 18px; }.dispatch-workspace { grid-template-columns: minmax(0, 1.1fr) minmax(350px, .9fr); } }
@media (max-width: 1100px) { .dispatch-page { padding: 20px 22px 24px; }.dispatch-workspace { grid-template-columns: 1fr; }.dispatch-policy { margin-left: 0; }.dispatch-filters { gap: 16px; }.dispatch-choice-numbers { align-items: start; flex-direction: column; gap: 8px; }.dispatch-choice-load > span:last-child { display: none; }.dispatch-map-placeholder { height: 470px; } }
@media (max-width: 680px) { .dispatch-page { padding: 16px; gap: 16px; }.dispatch-heading { align-items: start; flex-direction: column; gap: 12px; }.dispatch-source { width: 100%; justify-content: space-between; gap: 8px; }.dispatch-district { width: 100%; }.dispatch-horizon { flex: 1; }.dispatch-horizon > div { display: grid; grid-template-columns: repeat(3, 1fr); }.dispatch-horizon button { padding: 7px 9px; }.dispatch-policy { width: 100%; min-height: auto;  }.dispatch-policy small { display: inline; margin-left: 10px; }.dispatch-totals { padding: 14px 0; }.dispatch-totals > div { padding: 0 12px; gap: 0; }.dispatch-totals svg { display: none; }.dispatch-totals strong { font-size: var(--type-h5); }.dispatch-totals em {  margin-left: 4px; }.dispatch-comparison > header { align-items: start; flex-wrap: wrap; }.dispatch-comparison-controls { width: 100%; justify-content: space-between; }.dispatch-route-cards { display: flex; overflow-x: auto; scroll-snap-type: x mandatory; padding-bottom: 5px; }.dispatch-route-choice { min-width: 245px; flex: 1 0 82%; scroll-snap-align: start; }.dispatch-choice-numbers { flex-direction: row; align-items: center; }.dispatch-choice-load > span:last-child { display: inline; }.dispatch-unplanned summary { padding: 12px; }.dispatch-unplanned summary > span:last-child { font-size: var(--type-body2); white-space: nowrap; } }
@media (prefers-reduced-motion: reduce) { .dispatch-spin { animation: none; }.dispatch-route-choice { transition: none; } }
</style>
