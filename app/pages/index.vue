<script setup lang="ts">
import { ArrowRight, Bike, Info, LoaderCircle, RefreshCw, Route as RouteIcon, TriangleAlert } from '@lucide/vue'
import { buildDispatchRoutePlans, type DispatchRouteStop } from '~/shared/dispatch-route-planner'
import { buildLiveOperations, buildLiveOperationsForHorizon } from '~/shared/live-operations'
import { shortageWarningsFor } from '~/shared/shortage-warnings'
import { overrideStationsWithXgboost } from '~/shared/xgboost-overrides'
import { briefingFacts, summarize } from '~/composables/useLiveDashboard'
import { usePredictionMode } from '~/composables/usePredictionMode'
import type { HorizonKey, StationRisk } from '~/shared/ops'

const route = useRoute()
const router = useRouter()
const selectedStationId = ref(typeof route.query.station === 'string' ? route.query.station : '')
const observedRouteStops = ref<DispatchRouteStop[] | null>(null)
const horizon: HorizonKey = '60'
const { mode: predictionMode, xgboost } = usePredictionMode()
const live = useLiveDashboard()
const {
  selectedDistrict,
  selectionSource,
  locationMessage,
  syncDistrictFromContext,
} = useDistrictSelection({
  stations: () => live.dashboard.value?.stations,
  districts: () => live.dashboard.value?.districts,
  initialDistrict: () => typeof route.query.district === 'string' ? route.query.district : '',
})

const baselineDashboard = computed(() => live.dashboardForDistrict(selectedDistrict.value) || undefined)

/**
 * XGBoost mode swaps in `npm run predict:xgboost`'s snapshot for the stations
 * the hybrid deployment routed to it (baseline 60min F1 <= 60%); everything
 * else -- including the districts/stations picker source, which stays on
 * `live.dashboard` -- keeps using the rule baseline unchanged. Alerts,
 * dispatches, and the summary card are rebuilt from the overridden stations
 * via the same `buildLiveOperations` the baseline dashboard already uses, so
 * every downstream consumer (RiskMap, TaskQueue, StationDetailPanel,
 * AgentReviewCard) needs no XGBoost-specific handling.
 */
const dashboard = computed(() => {
  const base = baselineDashboard.value
  if (!base || predictionMode.value === 'baseline' || !xgboost.payload.value) return base

  const stations = overrideStationsWithXgboost(
    base.stations, xgboost.payload.value.stations, base.meta.asOf, xgboost.payload.value.generatedAt,
  )
  const plan = buildLiveOperations(stations, base.meta.asOf)
  const summary = summarize(stations, plan.alerts, plan.dispatches)
  return { ...base, stations, alerts: plan.alerts, dispatches: plan.dispatches, summary, briefingFacts: briefingFacts(summary) }
})
const contextQuery = computed<Record<string, string>>(() => {
  const query: Record<string, string> = {}
  if (selectedDistrict.value) query.district = selectedDistrict.value
  return query
})
const selectedStation = computed<StationRisk | null>(() => dashboard.value?.stations.find(station => station.id === selectedStationId.value) || null)
const districtPickerOptions = computed(() => [
  { value: '', label: '全部行政區' },
  ...(live.dashboard.value?.districts || []).map(district => ({ value: district, label: district })),
])
const asOfLabel = computed(() => {
  const date = live.payload.value?.meta.asOf || dashboard.value?.meta.asOf
  if (!date) return '尚未載入'
  return new Intl.DateTimeFormat('zh-TW', {
    month: 'long', day: 'numeric', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date(date))
})
const baselineStatus = computed(() => {
  if (live.profileError.value) return '目前只看即時庫存'
  const coverage = live.profileCoverage.value
  if (!coverage) return '正在載入歷史基線'
  if (!coverage.matchedStations) return '目前只看即時庫存'
  return `基線已對照 ${coverage.matchedStations}／${coverage.liveStations} 站`
})

/**
 * Read-only: switching the source is an analyst action on /admin/roi, not a
 * homepage control -- the dispatcher only needs to know which one is live so
 * they can explain why a station got flagged.
 */
const predictionSourceLabel = computed(() => predictionMode.value === 'xgboost'
  ? 'XGBoost（含鄰站特徵）快照'
  : '規則基線')

watch(selectedDistrict, (district) => {
  if (!import.meta.client) return
  const current = typeof route.query.district === 'string' ? route.query.district : ''
  if (district !== current) void router.replace({ query: district ? { district } : {} })
}, { immediate: true })

watch(() => route.query.district, (district) => {
  const nextDistrict = typeof district === 'string' ? district : ''
  syncDistrictFromContext(nextDistrict)
})

watch(dashboard, (value) => {
  if (selectedStationId.value && !value?.stations.some(station => station.id === selectedStationId.value)) selectedStationId.value = ''
})

/**
 * Opening alarm for prolonged shortages, raised once per tab session as soon
 * as the first live payload lands. Deliberately reads `live.dashboard` rather
 * than the district-filtered `dashboard`: an operator opening the console
 * needs the whole network's hour-long shortages, not only whichever district
 * the picker happens to have restored.
 */
const shortageAlarm = useShortageAlarm()
watch(live.dashboard, async (value) => {
  if (!value) return
  if (await shortageAlarm.notifyOnce(value)) await navigateTo('/dispatch')
}, { immediate: true })

// `?station=` is a deep-linkable URL contract, which needs picking up even
// when index.vue is already mounted (Nuxt reuses the page component across
// an in-app navigateTo to the same route).
watch(() => route.query.station, (station) => {
  if (typeof station === 'string' && station) selectedStationId.value = station
})

const currentPlanning = computed(() => {
  if (!dashboard.value) return { routes: [] }
  const operations = buildLiveOperationsForHorizon(dashboard.value.stations, dashboard.value.meta.asOf, 'now')
  return buildDispatchRoutePlans(operations.dispatches, dashboard.value.stations)
})
const currentTransferCount = computed(() => currentPlanning.value.routes.reduce((sum, item) => sum + item.totalTransferBikes, 0))
const shortageCount60 = computed(() => dashboard.value ? shortageWarningsFor(dashboard.value.stations, dashboard.value.meta.asOf, '60').length : 0)
const hasForecast = computed(() => dashboard.value?.stations.some(station => station.serviceStatus === 'operational' && station.forecast.horizons['60'].baselineStatus === 'matched') ?? false)
const dataStatus = computed(() => live.error.value ? '資料更新中斷' : live.pending.value ? '正在同步' : dashboard.value ? '官方即時站況' : '等待資料')

function focusDispatchQueue(event: MouseEvent) {
  event.preventDefault()
  selectedStationId.value = ''
  void nextTick(() => document.getElementById('dispatch-queue')?.scrollIntoView({ block: 'start' }))
}

</script>

<template>
  <div class="operations-home">
    <!-- <section class="overview-metrics" aria-label="營運摘要">
      <a href="#dispatch-queue" class="overview-metric metric-routes" @click="focusDispatchQueue">
        <div class="metric-label"><span>目前可行路線</span>
          <RouteIcon style="width: 1em; height: 1em" aria-hidden="true" />
        </div>
        <div class="metric-value">{{ dashboard ? currentPlanning.routes.length : '—' }}<span>條</span></div>
        <div class="metric-bottom"><span>{{ dashboard ? `建議搬運 ${currentTransferCount} 台` : '正在建立建議' }}</span>
          <ArrowRight style="width: 1em; height: 1em" aria-hidden="true" />
        </div>
      </a>
      <div class="overview-metric metric-risk">
        <div class="metric-label"><span>60 分鐘高風險</span>
          <TriangleAlert style="width: 1em; height: 1em" aria-hidden="true" />
        </div>
        <div class="metric-value">{{ hasForecast ? shortageCount60 : '—' }}<span>站</span></div>
        <div class="metric-bottom"><span>{{ hasForecast ? '預測缺車 · 不含目前空站' : '預測暫不可用' }}</span><span
            class="metric-tag">預測</span></div>
      </div>
      <NuxtLink :to="{ path: '/stations', query: contextQuery }" class="overview-metric metric-inventory"
        aria-label="目前空站／滿站，前往站點總覽">
        <div class="metric-label"><span>目前空站／滿站</span>
          <Bike style="width: 1em; height: 1em" aria-hidden="true" />
        </div>
        <div class="metric-value inventory-value"><span class="empty-count">{{ dashboard?.summary.emptyNow ?? '—'
        }}</span><i>/</i>{{ dashboard?.summary.fullNow ?? '—' }}<span>站</span></div>
        <div class="metric-bottom"><span>無車可借／無位可還</span><span class="metric-tag">即時</span></div>
      </NuxtLink>
    </section> -->

    <WarningPanel v-if="dashboard" :stations="dashboard.stations" :as-of="dashboard.meta.asOf"
      :summary="dashboard.summary" :realtime-low-bikes="dashboard.realtimeLowBikes"
      @select="selectedStationId = $event" />
    <DemandSurgePanel v-if="dashboard" :stations="dashboard.stations" @select="selectedStationId = $event" />
    <!-- <FrozenStationPanel v-if="dashboard" :stations="dashboard.stations" :frozen-stations="dashboard.frozenStations"
      @select="selectedStationId = $event" /> -->

    <section class="workspace-toolbar" aria-label="工作區範圍與資料狀態">
      <div class="workspace-district">
        <ModalPicker v-model="selectedDistrict" :label="selectionSource === 'location' ? '行政區（依位置）' : '行政區'"
          title="選擇行政區" :options="districtPickerOptions" />
        <span class="sr-only" role="status" aria-live="polite">{{ locationMessage }}</span>
      </div>
      <div class="source-meta">
        <div class="source-title"><span class="source-dot"
            :class="{ 'source-dot--warning': live.error.value || !dashboard }" />{{ dataStatus }}<span
            class="source-time">{{ asOfLabel }}</span></div>
        <p><span>全市{{ baselineStatus }}</span><span class="meta-divider">·</span><span>每 5 分鐘檢查更新</span></p>
      </div>
      <button class="ops-button button-quiet refresh-data" type="button" :disabled="live.pending.value"
        @click="live.refresh({ manual: true })">
        <LoaderCircle v-if="live.pending.value" style="width: 1em; height: 1em" aria-hidden="true"
          class="animate-spin motion-reduce:animate-none" />
        <RefreshCw v-else style="width: 1em; height: 1em" aria-hidden="true" />{{ live.pending.value ? '更新中' : '更新資料' }}
      </button>
    </section>

    <div v-if="live.pending.value && !dashboard" class="loading-board" role="status" aria-live="polite"
      aria-busy="true">
      <LoaderCircle style="width: 1em; height: 1em" aria-hidden="true"
        class="animate-spin motion-reduce:animate-none" />正在取得官方即時資料…
    </div>
    <div v-else-if="live.error.value && !dashboard" class="loading-board error-board" role="alert">
      <TriangleAlert style="width: 1em; height: 1em" aria-hidden="true" />官方即時資料暫時無法取得。
      <PageRetryButton :busy="live.pending.value" @retry="live.refresh({ manual: true })" />
    </div>

    <template v-else-if="dashboard">
      <p v-if="live.error.value" class="live-inline-error" role="alert">
        <TriangleAlert style="width: 1em; height: 1em" aria-hidden="true" />{{ live.error.value }} 目前顯示上一筆成功載入的資料。
      </p>
      <section class="operations-workspace" aria-label="路線與站點工作區">
        <RiskMap class="home-risk-map" :stations="dashboard.stations" :horizon="horizon"
          :selected-id="selectedStationId" data-mode="live" :district="selectedDistrict"
          :profile-coverage="live.profileCoverage.value" :profile-error="live.profileError.value"
          :route-stops="observedRouteStops" @select="selectedStationId = $event"
          @retry-baseline="live.refresh({ manual: true })" />
        <div class="operations-side-panel" :class="{ 'has-selected-station': selectedStation }">
          <TaskQueue id="dispatch-queue" :alerts="dashboard.alerts" :stations="dashboard.stations"
            :as-of="dashboard.meta.asOf" :context-query="contextQuery" @select="selectedStationId = $event"
            @observe-route="observedRouteStops = $event" />
          <StationDetailPanel :station="selectedStation" :stations="dashboard.stations" :history="[]" :horizon="horizon"
            docked data-mode="live" :context-query="contextQuery" @close="selectedStationId = ''"
            @select="selectedStationId = $event" />
        </div>
      </section>

      <footer class="home-footnote"><span>
          <Info style="width: 1em; height: 1em" aria-hidden="true" />僅提供分析與路線建議
        </span><span>預測來源：{{ predictionSourceLabel }}</span></footer>
      <AgentReviewCard :as-of="dashboard.meta.asOf" horizon="60" :district="selectedDistrict"
        :facts="dashboard.briefingFacts" :summary="dashboard.summary" />
    </template>
  </div>
</template>

<style>
.operations-home {
  max-width: 1760px;
  margin: 0 auto;
  padding: 20px 32px 28px;
  display: grid;
  gap: 16px;
}

.overview-metrics {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 16px;
}

.overview-metric {
  padding: 16px 20px 13px;
  border: 1px solid var(--line);
  border-radius: 12px;
  background: var(--panel);
  min-width: 0;
  position: relative;
  overflow: hidden;
}

.overview-metric::before {
  content: '';
  position: absolute;
  left: 0;
  top: 20px;
  bottom: 20px;
  width: 3px;
  background: var(--metric-color);
  border-radius: 0 3px 3px 0;
}

.metric-routes {
  --metric-color: var(--accent);
  background: color-mix(in srgb, var(--accent) 5%, var(--panel));
  text-decoration: none;
  transition: border-color .15s;
}

.metric-routes:hover {
  border-color: var(--accent);
}

.metric-risk {
  --metric-color: var(--warning);
}

.metric-inventory {
  --metric-color: var(--danger);
  color: var(--ink);
  text-decoration: none;
  transition: border-color .15s;
}

.metric-inventory:hover,
.metric-inventory:focus-visible {
  border-color: var(--danger);
}

.metric-label,
.metric-bottom {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.metric-label {
  font-size: var(--type-body1);
  font-weight: 600;
  color: var(--muted);
}

.metric-label svg {
  color: var(--metric-color);
  font-size: var(--icon-lg);
}

/* Hero figure: the H2 role, so it steps 40 -> 32 -> 28 without a breakpoint of its own. */
.metric-value {
  display: flex;
  align-items: baseline;
  gap: 10px;
  margin: 10px 0 10px;
  font-size: var(--type-h2);
  font-weight: 650;
  line-height: 1;
  font-variant-numeric: tabular-nums;
  letter-spacing: var(--type-h2-ls);
}

.metric-value>span:not(.empty-count) {
  color: var(--muted);
  font-size: var(--type-body2);
  font-weight: 500;
  letter-spacing: 0;
}

.metric-routes .metric-value {
  color: var(--accent);
}

.inventory-value i {
  font-size: var(--type-h4);
  font-style: normal;
  color: var(--line-strong);
  font-weight: 400;
}

.metric-bottom {
  font-size: var(--type-body2);
  line-height: 1.5;
  color: var(--muted);
}

.metric-bottom>svg {
  font-size: var(--icon-md);
  color: var(--accent);
}

.metric-tag {
  padding: 1px 6px;
  border: 1px solid var(--line);
  border-radius: 4px;
  font-size: var(--type-body2);
  white-space: nowrap;
}

.workspace-toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 18px;
  padding: 2px 0;
}

.workspace-district {
  width: 205px;
  flex-shrink: 0;
}

.workspace-district>div>span {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
}

.workspace-district>div {
  gap: 0;
}

.source-meta {
  flex: 1;
  min-width: 200px;
}

.source-title {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  font-size: var(--type-body2);
  font-weight: 600;
}

.source-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--accent);
}

.source-dot--warning {
  background: var(--warning);
}

.source-time {
  color: var(--muted);
  font-weight: 400;
  margin-left: 4px;
}

.source-meta p {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  color: var(--muted);
  font-size: var(--type-body2);
  margin: 5px 0 0 15px;
}

.meta-divider {
  color: var(--line-strong);
}

.ops-button {
  display: inline-flex;
  min-height: 44px;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 10px 15px;
  border: 1px solid transparent;
  border-radius: 7px;
  font-size: var(--type-body2);
  font-weight: 650;
  line-height: 1.4;
  text-decoration: none;
  transition: background .15s, border-color .15s;
}

.ops-button svg {
  font-size: var(--icon-md);
  flex-shrink: 0;
}

.button-primary {
  background: var(--accent);
  color: var(--on-accent);
  border-color: var(--accent);
}

.button-primary:hover {
  background: var(--accent-strong);
  border-color: var(--accent-strong);
}

.button-secondary {
  border-color: var(--line-strong);
  background: var(--panel);
  color: var(--ink);
}

.button-secondary:hover {
  border-color: var(--accent);
  background: color-mix(in srgb, var(--accent) 6%, var(--panel));
}

.button-quiet {
  border-color: var(--line);
  color: var(--muted);
  background: var(--panel);
}

.button-quiet:hover {
  border-color: var(--line-strong);
  color: var(--ink);
}

.operations-workspace {
  display: grid;
  grid-template-columns: minmax(0, 2.5fr) minmax(360px, 1fr);
  gap: 20px;
  align-items: start;
}

.operations-workspace>* {
  min-width: 0;
}

@media (min-width: 1101px) {
  .operations-side-panel.has-selected-station>#dispatch-queue {
    display: none;
  }
}

#dispatch-queue {
  scroll-margin-top: 24px;
}

.home-footnote {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 0 2px;
  color: var(--muted);
  font-size: var(--type-body2);
}

.home-footnote span {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.home-footnote svg {
  font-size: var(--icon-sm);
}

@media (max-width: 1279px) {
  .operations-home {
    padding: 18px 22px 24px;
  }

  .operations-workspace {
    grid-template-columns: minmax(0, 2fr) minmax(320px, 1fr);
    gap: 16px;
  }
}

@media (max-width: 1100px) {
  .operations-workspace {
    grid-template-columns: 1fr;
  }

  .overview-metrics {
    gap: 12px;
  }
}

@media (max-width: 640px) {
  .operations-home {
    padding: 16px;
    gap: 16px;
  }

  .overview-metrics {
    grid-template-columns: 1fr 1fr;
    gap: 10px;
  }

  .metric-routes {
    grid-column: 1 / -1;
    display: grid;
    grid-template-columns: 1fr auto;
    align-items: center;
    gap: 8px;
  }

  .metric-routes .metric-label {
    justify-content: start;
  }

  .metric-routes .metric-value {
    grid-column: 2;
    grid-row: 1 / 3;
    margin: 0;
  }

  .metric-routes .metric-bottom {
    grid-column: 1;
  }

  .metric-routes .metric-bottom svg {
    display: none;
  }

  .overview-metric {
    padding: 16px;
  }

  .metric-label {
    font-size: var(--type-body2);
    gap: 6px;
  }

  .metric-label svg {
    font-size: var(--icon-md);
  }

  .metric-tag {
    display: none;
  }

  .metric-value {
    margin-top: 14px;
  }

  .workspace-toolbar {
    gap: 12px;
  }

  .workspace-district {
    width: auto;
    flex: 1;
  }

  .source-meta {
    flex-basis: 100%;
    order: 3;
  }

  .source-time {
    margin-left: 0;
  }

  .refresh-data {
    align-self: end;
  }
}

@media (prefers-reduced-motion: reduce) {

  .operations-home *,
  .operations-home *::before {
    scroll-behavior: auto !important;
    transition: none !important;
    animation: none !important;
  }
}
</style>
