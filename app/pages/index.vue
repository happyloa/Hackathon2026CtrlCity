<script setup lang="ts">
import { Icon } from '@iconify/vue'
import { buildDispatchRoutePlans } from '~/shared/dispatch-route-planner'
import type { HorizonKey, StationRisk } from '~/shared/ops'

const route = useRoute()
const router = useRouter()
const selectedDistrict = ref(typeof route.query.district === 'string' ? route.query.district : '')
const selectedStationId = ref('')
const horizon: HorizonKey = '60'
const live = useLiveDashboard()

useLivePolling(live.refresh, computed(() => true))

const dashboard = computed(() => live.dashboardForDistrict(selectedDistrict.value) || undefined)
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
const inventoryAlertCount = computed(() => dashboard.value?.alerts.filter(alert => alert.condition !== 'unavailable').length || 0)
const routePlanCount = computed(() => dashboard.value
  ? buildDispatchRoutePlans(dashboard.value.dispatches, dashboard.value.stations).routes.length
  : 0)
const metricCards = computed(() => {
  const summary = dashboard.value?.summary
  if (!summary) return []
  return [
    { label: '建議路線', value: routePlanCount.value, caption: `${summary.recommendedMoves} 筆搬運需求已整合`, icon: 'solar:routing-2-outline', tone: 'positive' as const },
    { label: '庫存風險', value: inventoryAlertCount.value, caption: `含 ${summary.highRiskNext60m} 個 60 分鐘高風險站`, icon: 'solar:danger-triangle-outline', tone: 'warning' as const },
    { label: '目前無車／無位', value: `${summary.emptyNow}／${summary.fullNow}`, caption: '官方即時庫存', icon: 'solar:wheel-angle-outline', tone: 'critical' as const },
  ]
})
const baselineStatus = computed(() => {
  const coverage = live.profileCoverage.value
  if (!coverage) return '正在比對官方即時庫存與歷史基線。'
  if (!coverage.matchedStations) return '歷史基線暫不可用，目前僅依即時庫存判讀。'
  return `歷史基線已對照 ${coverage.matchedStations}／${coverage.liveStations} 個即時站點。`
})

watch(selectedDistrict, (district) => {
  if (!import.meta.client) return
  const current = typeof route.query.district === 'string' ? route.query.district : ''
  if (district !== current) void router.replace({ query: district ? { district } : {} })
})

watch(() => route.query.district, (district) => {
  const nextDistrict = typeof district === 'string' ? district : ''
  if (selectedDistrict.value !== nextDistrict) selectedDistrict.value = nextDistrict
})

watch(dashboard, (value) => {
  if (selectedStationId.value && !value?.stations.some(station => station.id === selectedStationId.value)) selectedStationId.value = ''
})
</script>

<template>
  <div class="mx-auto w-full max-w-screen-2xl space-y-4 px-4 py-4 sm:px-6 lg:px-8 lg:py-6" :class="{ 'motion-safe:animate-pulse': live.updated.value }">
    <section class="grid gap-4 rounded-xl border border-line bg-panel p-4 shadow-sm sm:p-5 lg:grid-cols-3">
      <div class="min-w-0 lg:col-span-2">
        <p class="inline-flex items-center gap-2 text-base font-semibold tracking-wide text-accent"><span class="size-2 rounded-full bg-positive" aria-hidden="true" /> 官方即時資料</p>
        <h2 class="mt-2 text-2xl font-bold tracking-tight">先看未來 60 分鐘，再規劃搬運路線</h2>
        <p class="mt-2 max-w-3xl text-base leading-7 text-muted">以最新庫存對照同站歷史基線，找出可能缺車或缺位的站點，並提供可解釋的調度規劃。</p>
      </div>
      <div class="flex min-w-0 flex-col justify-center rounded-lg border border-line bg-surface p-4">
        <span class="inline-flex items-center gap-2 text-base font-semibold text-muted"><Icon class="text-xl text-accent" icon="solar:calendar-date-outline" /> 資料時間</span>
        <strong class="mt-2 text-lg leading-7">{{ asOfLabel }}</strong>
        <span class="mt-1 text-base leading-6 text-muted">官方資料更新後自動同步</span>
      </div>
    </section>

    <section v-if="dashboard || live.dashboard.value" class="panel grid gap-4 p-4 sm:grid-cols-2 sm:p-5 lg:grid-cols-3">
      <ModalPicker v-model="selectedDistrict" label="行政區" title="選擇行政區" :options="districtPickerOptions" />
      <div class="flex min-h-11 min-w-0 flex-col justify-center">
        <span class="text-base font-semibold text-muted">預測範圍</span>
        <strong class="mt-1 text-lg">未來 60 分鐘</strong>
      </div>
      <div class="flex min-w-0 flex-col gap-1 sm:col-span-2 lg:col-span-1">
        <span class="text-base font-semibold text-muted">資料更新</span>
        <button class="inline-flex min-h-11 items-center justify-center gap-2 rounded-lg bg-accent px-3 text-base font-semibold text-on-accent transition-colors hover:bg-accent-strong disabled:cursor-wait disabled:opacity-70" type="button" :disabled="live.pending.value" @click="live.refresh({ manual: true })">
          <Icon class="text-xl" :icon="live.pending.value ? 'svg-spinners:3-dots-fade' : 'solar:refresh-circle-outline'" />
          {{ live.pending.value ? '更新中' : '立即更新' }}
        </button>
      </div>
      <div class="flex items-start gap-2 text-base leading-6 text-muted sm:col-span-2 lg:col-span-3" role="status" aria-live="polite">
        <Icon class="mt-1 shrink-0 text-xl text-accent" icon="solar:chart-square-outline" />
        {{ live.profileError.value ? '歷史基線暫時無法載入，目前仍顯示官方即時庫存。' : (live.updated.value ? '官方資料已更新，風險與規劃已重新計算。' : baselineStatus) }}
      </div>
    </section>

    <section v-if="dashboard" class="grid grid-cols-1 gap-3 md:grid-cols-3" aria-label="營運摘要">
      <MetricCard v-for="card in metricCards" :key="card.label" v-bind="card" />
    </section>

    <div v-if="live.pending.value && !dashboard" class="loading-board" role="status" aria-live="polite"><Icon icon="svg-spinners:3-dots-fade" />正在取得官方即時資料…</div>
    <div v-else-if="live.error.value && !dashboard" class="loading-board error-board" role="alert"><Icon icon="solar:danger-triangle-outline" />官方即時資料暫時無法取得，請稍後再試。</div>

    <template v-else-if="dashboard">
      <p v-if="live.error.value" class="live-inline-error text-base" role="alert"><Icon icon="solar:danger-triangle-outline" /> {{ live.error.value }}</p>
      <section class="grid grid-cols-1 gap-4 xl:grid-cols-2 xl:items-start">
        <TaskQueue :alerts="dashboard.alerts" :dispatches="dashboard.dispatches" :stations="dashboard.stations" :context-query="contextQuery" @select="selectedStationId = $event" />
        <RiskMap
          :stations="dashboard.stations"
          :horizon="horizon"
          :selected-id="selectedStationId"
          data-mode="live"
          :district="selectedDistrict"
          :profile-coverage="live.profileCoverage.value"
          :profile-error="live.profileError.value"
          @select="selectedStationId = $event"
          @retry-baseline="live.refresh({ manual: true })"
        />
      </section>

      <StationDetailPanel :station="selectedStation" :stations="dashboard.stations" :history="[]" :horizon="horizon" data-mode="live" :context-query="contextQuery" @close="selectedStationId = ''" @select="selectedStationId = $event" />

      <AgentReviewCard :as-of="dashboard.meta.asOf" horizon="60" :district="selectedDistrict" :facts="dashboard.briefingFacts" :summary="dashboard.summary" />

      <DisclosurePanel class="panel mt-4" title="模型依據與驗證" description="查看歷史基線、離線驗證與使用界線" icon="solar:chart-square-outline">
        <div class="space-y-3 p-4 sm:p-5">
          <OperationalEvidence :as-of="dashboard.meta.asOf" data-mode="live" />
          <section class="flex items-start gap-2 rounded-lg bg-surface p-3 text-base leading-6 text-muted">
            <Icon class="mt-1 shrink-0 text-xl text-accent" icon="solar:info-circle-outline" />
            <span>60 分鐘風險由即時庫存與同站、同時段歷史基線產生；平台只提供分析與路線建議，不會送出真實派車命令。</span>
          </section>
        </div>
      </DisclosurePanel>
    </template>
  </div>
</template>
