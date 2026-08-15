<script setup lang="ts">
import { Icon } from '@iconify/vue'
import type { HorizonKey, StationRisk } from '~/shared/ops'

type SourceMode = 'historical_replay' | 'live'

const route = useRoute()
const router = useRouter()
const selectedAt = ref(typeof route.query.at === 'string' ? route.query.at : '')
const selectedDistrict = ref(typeof route.query.district === 'string' ? route.query.district : '')
const horizon = ref<HorizonKey>('60')
const selectedStationId = ref('')
const sourceMode = ref<SourceMode>(route.query.mode === 'historical_replay' ? 'historical_replay' : 'live')
const liveOperations = useLiveDashboard()
const livePayload = liveOperations.payload
const liveDashboard = liveOperations.dashboard
const livePending = liveOperations.pending
const liveError = liveOperations.error
const liveProfileError = liveOperations.profileError
const liveUpdateState = computed<'idle' | 'updated'>(() => liveOperations.updated.value ? 'updated' : 'idle')
const refreshLive = liveOperations.refresh
const horizonOptions: HorizonKey[] = ['30', '60', '120']
const liveHorizonOptions: HorizonKey[] = ['30', '60']
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
  if (mode === 'live') {
    if (horizon.value === '120') horizon.value = '60'
  } else {
    void loadScenario(selectedAt.value || undefined)
  }
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
      { label: '目前無車', value: summary.emptyNow, caption: '官方即時庫存', icon: 'solar:wheel-angle-outline', tone: 'critical' as const },
      { label: '目前無位', value: summary.fullNow, caption: '官方即時庫存', icon: 'solar:garage-outline', tone: 'warning' as const },
      { label: '待確認告警', value: summary.persistentAlerts, caption: `含 ${summary.highRiskNext60m} 個 60 分鐘高風險站`, icon: 'solar:danger-triangle-outline', tone: 'warning' as const },
      { label: '待覆核任務', value: summary.recommendedMoves, caption: '即時補車與移車建議', icon: 'solar:routing-2-outline', tone: 'positive' as const },
    ]
  }
  return [
    { label: '目前無車', value: summary.emptyNow, caption: '歷史回放當下狀態', icon: 'solar:wheel-angle-outline', tone: 'critical' as const },
    { label: '目前無位', value: summary.fullNow, caption: '歷史回放當下狀態', icon: 'solar:garage-outline', tone: 'warning' as const },
    { label: '60 分鐘高風險', value: summary.highRiskNext60m, caption: '依驗證門檻篩選', icon: 'solar:graph-up-outline', tone: 'warning' as const },
    { label: '建議任務', value: summary.recommendedMoves, caption: '補車與移車決策支援', icon: 'solar:routing-2-outline', tone: 'positive' as const },
  ]
})

const modeTitle = computed(() => sourceMode.value === 'live' ? '站點供需總覽' : '歷史調度回放')
const modeDescription = computed(() => sourceMode.value === 'live'
  ? '資料更新後，以同站、同時段歷史基線標示 30／60 分鐘風險，轉成待確認告警與待覆核搬運任務。'
  : '選擇一個時點，回看庫存、告警與補車／移車建議；皆需由值班人員覆核。')

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
  document.querySelector('.station-detail')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
}
</script>

<template>
  <div class="dashboard-page" :class="{ 'live-update-flash': sourceMode === 'live' && liveUpdateState === 'updated' }">
    <section class="command-intro">
      <div>
        <p class="eyebrow"><span class="live-dot" /> {{ sourceMode === 'live' ? '官方即時資料' : '歷史資料回放' }}</p>
        <h2>{{ modeTitle }}</h2>
        <p>{{ modeDescription }}</p>
      </div>
      <div class="intro-data-note">
        <span><Icon icon="solar:calendar-date-outline" /> 資料時間</span>
        <strong>{{ asOfLabel }}</strong>
        <small v-if="sourceMode === 'historical_replay'">歷史回放 · {{ activeDashboard?.meta.modelVersion || '尚未載入' }}</small>
      </div>
    </section>

    <section v-if="activeDashboard || sourceMode === 'live'" class="control-bar panel">
      <div class="source-switch" role="group" aria-label="資料模式">
        <span>資料模式</span>
        <div class="segmented">
          <button type="button" :class="{ active: sourceMode === 'live' }" @click="sourceMode = 'live'"><Icon icon="solar:bolt-circle-outline" /> 即時站況</button>
          <button type="button" :class="{ active: sourceMode === 'historical_replay' }" @click="sourceMode = 'historical_replay'"><Icon icon="solar:clock-circle-outline" /> 歷史預測</button>
        </div>
      </div>
      <label v-if="sourceMode === 'historical_replay'">
        <span>回放時點</span>
        <select v-model="selectedAt">
          <option v-for="time in dateOptions" :key="time" :value="time">{{ scenarioOptionLabel(time) }}</option>
        </select>
      </label>
      <label>
        <span>行政區</span>
        <select v-model="selectedDistrict">
          <option value="">全部行政區</option>
          <option v-for="district in districtOptions" :key="district" :value="district">{{ district }}</option>
        </select>
      </label>
      <div class="horizon-switch" role="group" aria-label="風險時間窗">
        <span>{{ sourceMode === 'live' ? '風險時間' : '預測時間窗' }}</span>
        <div>
          <button v-for="item in (sourceMode === 'live' ? liveHorizonOptions : horizonOptions)" :key="item" type="button" :class="{ active: horizon === item }" @click="horizon = item">{{ item }}m</button>
        </div>
      </div>
      <button v-if="sourceMode === 'live'" class="live-refresh-button" type="button" :disabled="livePending" @click="refreshLive({ manual: true })">
        <Icon :icon="livePending ? 'svg-spinners:3-dots-fade' : 'solar:refresh-circle-outline'" />
        {{ livePending ? '比對中' : '立即更新' }}
      </button>
      <div class="control-note">
        <Icon :icon="sourceMode === 'live' ? 'solar:refresh-circle-outline' : 'solar:shield-warning-outline'" />
        {{ sourceMode === 'live'
          ? (liveUpdateState === 'updated' ? '官方資料已更新，畫面已同步。' : (liveProfileError || '約每 5 分鐘比對官方資料；只有資料變更才更新畫面。'))
          : '歷史回放不會覆寫即時資料。' }}
      </div>
    </section>

    <section v-if="activeDashboard" class="metric-grid" aria-label="營運摘要">
      <MetricCard v-for="card in metricCards" :key="card.label" v-bind="card" />
    </section>

    <div v-if="activePending && !activeDashboard" class="loading-board"><Icon icon="svg-spinners:3-dots-fade" />{{ sourceMode === 'live' ? '正在取得官方即時資料…' : '正在載入歷史回放資料…' }}</div>
    <div v-else-if="activeError && !activeDashboard" class="loading-board error-board"><Icon icon="solar:danger-triangle-outline" />{{ sourceMode === 'live' ? '官方即時資料暫時無法取得，請稍後再試。' : '歷史資料暫時無法取得，請重新整理後再試。' }}</div>

    <template v-else-if="activeDashboard">
      <p v-if="sourceMode === 'live' && liveError" class="live-inline-error"><Icon icon="solar:danger-triangle-outline" /> {{ liveError }}</p>
      <section class="dashboard-grid primary-grid">
        <RiskMap :stations="activeDashboard.stations" :horizon="horizon" :selected-id="selectedStationId" :data-mode="sourceMode" @select="selectStation" />
        <div class="operation-rail">
          <AlertList :alerts="activeDashboard.alerts" :stations="activeDashboard.stations" :context-query="contextQuery" compact @select="selectStation" @acknowledge="acknowledge" />
          <DispatchList :dispatches="activeDashboard.dispatches" :stations="activeDashboard.stations" :context-query="contextQuery" compact @select="selectStation" @accept="acceptDispatch" />
          <StationDetailPanel :station="selectedStation" :stations="activeDashboard.stations" :history="selectedHistory" :horizon="horizon" :data-mode="sourceMode" :context-query="contextQuery" @close="selectedStationId = ''" @select="selectStation" />
        </div>
      </section>

      <OperationalEvidence :as-of="activeDashboard.meta.asOf" :data-mode="sourceMode" />

      <template v-if="sourceMode === 'historical_replay'">
        <BriefingCard
          :as-of="activeMeta?.asOf || activeDashboard.meta.asOf"
          :horizon="horizon"
          :district="selectedDistrict"
          :facts="activeDashboard.briefingFacts"
          :summary="activeDashboard.summary"
        />
        <section class="data-footnote">
          <Icon icon="solar:info-circle-outline" />
          <span>歷史回放使用已整理資料產生庫存風險與雙向調度建議；可借、可還皆為 0 時只標示為疑似服務異常，需人工確認。</span>
        </section>
      </template>
      <template v-else>
        <section class="data-footnote">
          <Icon icon="solar:info-circle-outline" />
          <span>30／60 分鐘為即時庫存結合同站歷史時段的啟發式風險指標，不是校準後事件機率；告警與任務依優先分數排序，每次最多列出 80 筆告警與 16 筆任務。確認與指派只存在於目前瀏覽器，不會送出真實車隊命令。</span>
        </section>
      </template>
    </template>
  </div>
</template>
