<script setup lang="ts">
import { Icon } from '@iconify/vue'
import type { HorizonKey, StationRisk } from '~/shared/ops'

type SourceMode = 'historical_replay' | 'live'

const route = useRoute()
const router = useRouter()
const selectedAt = ref(typeof route.query.at === 'string' ? route.query.at : '')
const selectedDistrict = ref(typeof route.query.district === 'string' ? route.query.district : '')
const horizon: HorizonKey = '60'
const selectedStationId = ref('')
const sourceMode = ref<SourceMode>(route.query.mode === 'historical_replay' ? 'historical_replay' : 'live')
const liveOperations = useLiveDashboard()
const livePayload = liveOperations.payload
const liveDashboard = liveOperations.dashboard
const livePending = liveOperations.pending
const liveError = liveOperations.error
const liveProfileError = liveOperations.profileError
const liveProfileCoverage = liveOperations.profileCoverage
const liveUpdateState = computed<'idle' | 'updated'>(() => liveOperations.updated.value ? 'updated' : 'idle')
const refreshLive = liveOperations.refresh
useLivePolling(refreshLive, computed(() => sourceMode.value === 'live'))

const {
  manifest: replayManifest,
  dashboard: replayArtifact,
  selectedAsOf: replaySelectedAsOf,
  pending: replayPending,
  error: replayError,
  loadScenario,
  acknowledge: acknowledgeReplay,
  acceptDispatch: acceptReplay,
  dashboardForDistrict,
} = useReplayDashboard()

const historicalDashboard = computed(() => dashboardForDistrict(selectedDistrict.value))
const liveScopedDashboard = computed(() => liveOperations.dashboardForDistrict(selectedDistrict.value))
const activeDashboard = computed(() => sourceMode.value === 'live' ? liveScopedDashboard.value || undefined : historicalDashboard.value || undefined)
const activeMeta = computed(() => sourceMode.value === 'live' ? livePayload.value?.meta : historicalDashboard.value?.meta)
const activePending = computed(() => sourceMode.value === 'live' ? livePending.value : replayPending.value)
const activeError = computed(() => sourceMode.value === 'live' ? liveError.value : replayError.value)
const contextQuery = computed<Record<string, string>>(() => {
  const query: Record<string, string> = { mode: sourceMode.value }
  if (sourceMode.value === 'historical_replay' && selectedAt.value) query.at = selectedAt.value
  if (selectedDistrict.value) query.district = selectedDistrict.value
  return query
})

watch(replaySelectedAsOf, (value) => {
  if (value && selectedAt.value !== value) selectedAt.value = value
})

watch(contextQuery, (query) => {
  if (!import.meta.client) return
  const current = Object.fromEntries(Object.entries(route.query).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
  if (JSON.stringify(current) !== JSON.stringify(query)) void router.replace({ query })
}, { deep: true })

watch(() => route.query, (query) => {
  const nextMode: SourceMode = query.mode === 'historical_replay' ? 'historical_replay' : 'live'
  const nextDistrict = typeof query.district === 'string' ? query.district : ''
  const nextAsOf = typeof query.at === 'string' ? query.at : ''
  if (sourceMode.value !== nextMode) sourceMode.value = nextMode
  if (selectedDistrict.value !== nextDistrict) selectedDistrict.value = nextDistrict
  if (nextMode === 'historical_replay' && selectedAt.value !== nextAsOf) selectedAt.value = nextAsOf
}, { deep: true })

watch(activeDashboard, (value) => {
  if (!value) return
  if (sourceMode.value === 'historical_replay' && !selectedAt.value) selectedAt.value = value.meta.asOf
  if (selectedStationId.value && !value.stations.some(station => station.id === selectedStationId.value)) selectedStationId.value = ''
}, { immediate: true })

watch(sourceMode, (mode) => {
  if (mode === 'historical_replay') void loadScenario(selectedAt.value || undefined)
})

watch(selectedAt, () => {
  if (sourceMode.value === 'historical_replay' && selectedAt.value !== replayArtifact.value?.meta.asOf) {
    void loadScenario(selectedAt.value)
  }
})

onMounted(() => {
  if (sourceMode.value === 'historical_replay') {
    void loadScenario(selectedAt.value || undefined)
  }
})

const selectedStation = computed<StationRisk | null>(() => activeDashboard.value?.stations.find(station => station.id === selectedStationId.value) || null)
const selectedHistory = computed(() => sourceMode.value === 'historical_replay' && selectedStationId.value ? activeDashboard.value?.stationHistories[selectedStationId.value] || [] : [])
const dateOptions = computed(() => replayManifest.value?.availableTimes || replayArtifact.value?.availableTimes || [])
const districtOptions = computed(() => activeDashboard.value?.districts || replayManifest.value?.districts || [])
function scenarioOptionLabel(time: string) {
  const date = new Intl.DateTimeFormat('zh-TW', { month: '2-digit', day: '2-digit', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(time))
  return `${replayManifest.value?.labels[time] || '歷史營運情境'} · ${date}`
}
const replayPickerOptions = computed(() => dateOptions.value.map(time => ({ value: time, label: scenarioOptionLabel(time) })))
const districtPickerOptions = computed(() => [
  { value: '', label: '全部行政區' },
  ...districtOptions.value.map(district => ({ value: district, label: district })),
])
const asOfLabel = computed(() => {
  const date = activeMeta.value?.asOf || activeDashboard.value?.meta.asOf
  if (!date) return '尚未載入'
  return new Intl.DateTimeFormat('zh-TW', { month: 'long', day: 'numeric', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(date))
})

const metricCards = computed(() => {
  const summary = activeDashboard.value?.summary
  if (!summary) return []
  if (sourceMode.value === 'live') {
    return [
      { label: '待指派任務', value: summary.recommendedMoves, caption: '依優先分數排序', icon: 'solar:routing-2-outline', tone: 'positive' as const },
      { label: '待確認風險', value: summary.persistentAlerts, caption: `含 ${summary.highRiskNext60m} 個 60 分鐘高風險站`, icon: 'solar:danger-triangle-outline', tone: 'warning' as const },
      { label: '目前無車／無位', value: `${summary.emptyNow}／${summary.fullNow}`, caption: '官方即時庫存', icon: 'solar:wheel-angle-outline', tone: 'critical' as const },
    ]
  }
  return [
    { label: '待指派任務', value: summary.recommendedMoves, caption: '依優先分數排序', icon: 'solar:routing-2-outline', tone: 'positive' as const },
    { label: '待確認風險', value: summary.persistentAlerts, caption: `含 ${summary.highRiskNext60m} 個 60 分鐘高風險站`, icon: 'solar:danger-triangle-outline', tone: 'warning' as const },
    { label: '當下無車／無位', value: `${summary.emptyNow}／${summary.fullNow}`, caption: '歷史回放時點', icon: 'solar:wheel-angle-outline', tone: 'critical' as const },
  ]
})

const modeTitle = computed(() => sourceMode.value === 'live' ? '先處理高優先任務' : '重演歷史營運情境')
const modeDescription = computed(() => sourceMode.value === 'live'
  ? '依官方即時庫存與同站歷史基線排序，逐筆覆核 60 分鐘風險與搬運建議。'
  : '選擇歷史時點，重現風險確認與任務指派；不影響即時工作佇列。')
const liveComparisonStatus = computed(() => {
  const coverage = liveProfileCoverage.value
  if (!coverage) return '正在比對官方即時庫存與歷史基線。'
  if (!coverage.matchedStations) return '目前沒有可用的歷史基線對照，僅顯示即時庫存。'
  return `已以歷史基線比對 ${coverage.matchedStations}／${coverage.liveStations} 個即時站點。`
})

function acknowledge(alertId: string) {
  if (sourceMode.value === 'live') liveOperations.acknowledge(alertId)
  else acknowledgeReplay(alertId)
}

function acceptDispatch(dispatchId: string) {
  if (sourceMode.value === 'live') liveOperations.acceptDispatch(dispatchId)
  else acceptReplay(dispatchId)
}

function selectStation(stationId: string) {
  selectedStationId.value = stationId
}
</script>

<template>
  <div class="mx-auto w-full max-w-screen-2xl space-y-4 px-4 py-4 sm:px-6 lg:px-8 lg:py-6" :class="{ 'motion-safe:animate-pulse': sourceMode === 'live' && liveUpdateState === 'updated' }">
    <section class="grid gap-4 rounded-xl border border-line bg-panel p-4 shadow-sm sm:p-5 lg:grid-cols-3">
      <div class="min-w-0 lg:col-span-2">
        <p class="inline-flex items-center gap-2 text-base font-semibold tracking-wide text-accent"><span class="size-2 rounded-full bg-positive" aria-hidden="true" /> {{ sourceMode === 'live' ? '官方即時資料' : '歷史資料回放' }}</p>
        <h2 class="mt-2 text-2xl font-bold tracking-tight">{{ modeTitle }}</h2>
        <p class="mt-2 max-w-3xl text-base leading-7 text-muted">{{ modeDescription }}</p>
      </div>
      <div class="flex min-w-0 flex-col justify-center rounded-lg border border-line bg-surface p-4">
        <span class="inline-flex items-center gap-2 text-base font-semibold text-muted"><Icon class="text-xl text-accent" icon="solar:calendar-date-outline" /> 資料時間</span>
        <strong class="mt-2 text-lg leading-7">{{ asOfLabel }}</strong>
        <span v-if="sourceMode === 'historical_replay'" class="mt-1 text-base leading-6 text-muted">歷史回放 · {{ activeDashboard?.meta.modelVersion || '尚未載入' }}</span>
      </div>
    </section>

    <section v-if="activeDashboard || sourceMode === 'live'" class="panel grid gap-4 p-4 sm:grid-cols-2 sm:p-5 xl:grid-cols-5">
      <div class="min-w-0 sm:col-span-2 xl:col-span-1" role="group" aria-label="資料模式">
        <span class="block text-base font-semibold text-muted">工作模式</span>
        <div class="mt-1 grid grid-cols-2 gap-1 rounded-lg border border-line bg-surface p-1">
          <button class="inline-flex min-h-11 items-center justify-center gap-2 rounded-md px-2 text-base font-semibold transition-colors" :class="sourceMode === 'live' ? 'bg-accent text-on-accent shadow-sm' : 'text-muted hover:bg-panel hover:text-ink'" type="button" :aria-pressed="sourceMode === 'live'" @click="sourceMode = 'live'"><Icon class="shrink-0 text-xl" icon="solar:bolt-circle-outline" /><span>即時調度</span></button>
          <button class="inline-flex min-h-11 items-center justify-center gap-2 rounded-md px-2 text-base font-semibold transition-colors" :class="sourceMode === 'historical_replay' ? 'bg-accent text-on-accent shadow-sm' : 'text-muted hover:bg-panel hover:text-ink'" type="button" :aria-pressed="sourceMode === 'historical_replay'" @click="sourceMode = 'historical_replay'"><Icon class="shrink-0 text-xl" icon="solar:clock-circle-outline" /><span>歷史演練</span></button>
        </div>
      </div>
      <ModalPicker
        v-if="sourceMode === 'historical_replay'"
        v-model="selectedAt"
        label="回放時點"
        title="選擇歷史回放時點"
        :options="replayPickerOptions"
        empty-label="尚無可回放情境"
      />
      <ModalPicker
        v-model="selectedDistrict"
        label="行政區"
        title="選擇行政區"
        :options="districtPickerOptions"
      />
      <div class="flex min-h-11 min-w-0 flex-col justify-center" :aria-label="sourceMode === 'live' ? '即時風險時間' : '歷史演練風險時間'">
        <span class="text-base font-semibold text-muted">風險時間</span>
        <strong class="mt-1 text-lg">60 分鐘</strong>
      </div>
      <div v-if="sourceMode === 'live'" class="flex min-w-0 flex-col gap-1">
        <span class="text-base font-semibold text-muted">資料更新</span>
        <button class="inline-flex min-h-11 items-center justify-center gap-2 rounded-lg bg-accent px-3 text-base font-semibold text-on-accent transition-colors hover:bg-accent-strong" type="button" :disabled="livePending" @click="refreshLive({ manual: true })">
          <Icon class="text-xl" :icon="livePending ? 'svg-spinners:3-dots-fade' : 'solar:refresh-circle-outline'" />
          {{ livePending ? '比對中' : '立即更新' }}
        </button>
      </div>
      <div class="flex items-start gap-2 text-base leading-6 text-muted sm:col-span-2 xl:col-span-5" role="status" aria-live="polite">
        <Icon class="mt-1 shrink-0 text-xl text-accent" :icon="sourceMode === 'live' ? 'solar:refresh-circle-outline' : 'solar:shield-warning-outline'" />
        {{ sourceMode === 'live'
          ? (liveProfileError ? '歷史基線暫時無法載入，僅顯示即時庫存；按立即更新即可重新比對。' : (liveUpdateState === 'updated' ? '官方資料已更新，畫面已同步。' : liveComparisonStatus))
          : '歷史回放不會覆寫即時資料。' }}
      </div>
    </section>

    <section v-if="activeDashboard" class="grid grid-cols-1 gap-3 md:grid-cols-3" aria-label="營運摘要">
      <MetricCard v-for="card in metricCards" :key="card.label" v-bind="card" />
    </section>

    <div v-if="activePending && !activeDashboard" class="loading-board" role="status" aria-live="polite"><Icon icon="svg-spinners:3-dots-fade" />{{ sourceMode === 'live' ? '正在取得官方即時資料…' : '正在載入歷史回放資料…' }}</div>
    <div v-else-if="activeError && !activeDashboard" class="loading-board error-board" role="alert"><Icon icon="solar:danger-triangle-outline" />{{ sourceMode === 'live' ? '官方即時資料暫時無法取得，請稍後再試。' : '歷史資料暫時無法取得，請重新整理後再試。' }}</div>

    <template v-else-if="activeDashboard">
      <p v-if="sourceMode === 'live' && liveError" class="live-inline-error text-base" role="alert"><Icon icon="solar:danger-triangle-outline" /> {{ liveError }}</p>
      <section class="grid grid-cols-1 gap-4 xl:grid-cols-2 xl:items-start">
        <TaskQueue
          :alerts="activeDashboard.alerts"
          :dispatches="activeDashboard.dispatches"
          :stations="activeDashboard.stations"
          :data-mode="sourceMode"
          :context-query="contextQuery"
          @select="selectStation"
          @acknowledge="acknowledge"
          @accept="acceptDispatch"
        />
        <RiskMap
          :stations="activeDashboard.stations"
          :horizon="horizon"
          :selected-id="selectedStationId"
          :data-mode="sourceMode"
          :district="selectedDistrict"
          :profile-coverage="sourceMode === 'live' ? liveProfileCoverage : null"
          :profile-error="sourceMode === 'live' ? liveProfileError : ''"
          @select="selectStation"
          @retry-baseline="refreshLive({ manual: true })"
        />
      </section>

      <StationDetailPanel :station="selectedStation" :stations="activeDashboard.stations" :history="selectedHistory" :horizon="horizon" :data-mode="sourceMode" :context-query="contextQuery" @close="selectedStationId = ''" @select="selectStation" />

      <AgentReviewCard
        v-if="sourceMode === 'live'"
        :as-of="activeDashboard.meta.asOf"
        horizon="60"
        :district="selectedDistrict"
        :facts="activeDashboard.briefingFacts"
        :summary="activeDashboard.summary"
      />

      <DisclosurePanel
        class="panel mt-4"
        title="判讀依據與交班摘要"
        description="查看資料說明、歷史驗證與情境摘要"
        icon="solar:chart-square-outline"
      >
        <div class="space-y-3 p-4 sm:p-5">
          <OperationalEvidence :as-of="activeDashboard.meta.asOf" :data-mode="sourceMode" />
          <section class="flex items-start gap-2 rounded-lg bg-surface p-3 text-base leading-6 text-muted">
            <Icon class="mt-1 shrink-0 text-xl text-accent" icon="solar:info-circle-outline" />
            <span>{{ sourceMode === 'live'
              ? '60 分鐘風險以即時庫存對照同站、同時段歷史資料產生，不是校準後事件機率；確認與指派只存在於目前瀏覽器。'
              : '歷史演練使用已整理資料產生庫存風險與雙向調度建議；可借、可還皆為 0 時只標示為疑似服務異常，仍需人工確認。' }}</span>
          </section>
        </div>
      </DisclosurePanel>
    </template>
  </div>
</template>
