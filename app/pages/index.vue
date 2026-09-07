<script setup lang="ts">
import { Icon } from '@iconify/vue'
import type { DispatchRouteStop } from '~/shared/dispatch-route-planner'
import { buildLiveOperations } from '~/shared/live-operations'
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

// `?station=` is a deep-linkable URL contract, which needs picking up even
// when index.vue is already mounted (Nuxt reuses the page component across
// an in-app navigateTo to the same route).
watch(() => route.query.station, (station) => {
  if (typeof station === 'string' && station) selectedStationId.value = station
})
</script>

<template>
  <div class="mx-auto w-full max-w-screen-3xl space-y-4 px-4 py-4 sm:px-6 lg:px-8 lg:py-6">
    <WarningPanel v-if="dashboard" :stations="dashboard.stations" :as-of="dashboard.meta.asOf"
      :summary="dashboard.summary" @select="selectedStationId = $event" />

    <section class="grid gap-4 rounded-xl border border-line bg-panel p-4 shadow-sm sm:p-5 lg:grid-cols-3">
      <div class="min-w-0 lg:col-span-2">
        <p class="inline-flex items-center gap-2 text-base font-semibold tracking-wide text-accent"><span
            class="size-2 rounded-full bg-positive" aria-hidden="true" /> 官方即時資料</p>
        <!-- <h2 class="mt-2 text-2xl font-bold tracking-tight">未來 60 分鐘站況</h2> -->
        <div class="flex min-w-0 flex-col gap-1">
          <span class="text-base font-semibold text-muted">{{ baselineStatus }}</span>
          <span class="inline-flex w-fit items-center gap-2 rounded-lg bg-surface px-3 py-1 text-base font-semibold text-muted">
            <Icon class="text-lg text-accent" icon="solar:cpu-bolt-outline" /> 預測來源：{{ predictionSourceLabel }}
          </span>
          <span class="sr-only" role="status" aria-live="polite">{{ locationMessage }}</span>
          <button
            class="inline-flex min-h-11 items-center justify-center gap-2 rounded-lg bg-accent px-3 text-base font-semibold text-on-accent transition-colors hover:bg-accent-strong disabled:cursor-wait disabled:opacity-70"
            type="button" :disabled="live.pending.value" @click="live.refresh({ manual: true })">
            <Icon class="text-xl"
              :icon="live.pending.value ? 'svg-spinners:3-dots-fade' : 'solar:refresh-circle-outline'" />
            {{ live.pending.value ? '更新中' : '立即更新' }}
          </button>
        </div>
        <ModalPicker v-model="selectedDistrict" :label="selectionSource === 'location' ? '行政區（依位置）' : '行政區'"
          title="選擇行政區" :options="districtPickerOptions" />

        <span class="sr-only" role="status" aria-live="polite">{{ locationMessage }}</span>
      </div>
      <div class="flex min-w-0 flex-col justify-center rounded-lg border border-line bg-surface p-4">
        <span class="inline-flex items-center gap-2 text-base font-semibold text-muted">
          <Icon class="text-xl text-accent" icon="solar:calendar-date-outline" /> 資料時間
        </span>
        <strong class="mt-2 text-lg leading-7">{{ asOfLabel }}</strong>
        <span class="mt-1 text-base leading-6 text-muted">每 5 分鐘自動更新</span>
      </div>
    </section>

    <div v-if="live.pending.value && !dashboard" class="loading-board" role="status" aria-live="polite">
      <Icon icon="svg-spinners:3-dots-fade" />正在取得官方即時資料…
    </div>
    <div v-else-if="live.error.value && !dashboard" class="loading-board error-board" role="alert">
      <Icon icon="solar:danger-triangle-outline" />官方即時資料暫時無法取得，請稍後再試。
    </div>

    <template v-else-if="dashboard">
      <p v-if="live.error.value" class="live-inline-error text-base" role="alert">
        <Icon icon="solar:danger-triangle-outline" /> {{ live.error.value }}
      </p>

      <section class="grid grid-cols-1 gap-4 xl:grid-cols-2 xl:items-start">

        <RiskMap :stations="dashboard.stations" :horizon="horizon" :selected-id="selectedStationId" data-mode="live"
          :district="selectedDistrict" :profile-coverage="live.profileCoverage.value"
          :profile-error="live.profileError.value" :route-stops="observedRouteStops"
          @select="selectedStationId = $event" @retry-baseline="live.refresh({ manual: true })" />
        <TaskQueue :alerts="dashboard.alerts" :stations="dashboard.stations" :as-of="dashboard.meta.asOf"
          :context-query="contextQuery" @select="selectedStationId = $event"
          @observe-route="observedRouteStops = $event" />
      </section>

      <StationDetailPanel :station="selectedStation" :stations="dashboard.stations" :history="[]" :horizon="horizon"
        data-mode="live" :context-query="contextQuery" @close="selectedStationId = ''"
        @select="selectedStationId = $event" />

      <AgentReviewCard :as-of="dashboard.meta.asOf" horizon="60" :district="selectedDistrict"
        :facts="dashboard.briefingFacts" :summary="dashboard.summary" />
    </template>
  </div>
</template>
