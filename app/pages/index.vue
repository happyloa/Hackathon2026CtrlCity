<script setup lang="ts">
import { Icon } from '@iconify/vue'
import type {
  ApiEnvelope,
  DashboardArtifact,
  Forecast,
  HorizonKey,
  LiveStation,
  LiveStationsPayload,
  StationRisk,
} from '~/shared/ops'

type SourceMode = 'historical_replay' | 'live'
type LiveResponse = ApiEnvelope<LiveStationsPayload>

const LIVE_POLL_INTERVAL_MS = 5 * 60 * 1000
const selectedAt = ref('')
const selectedDistrict = ref('')
const horizon = ref<HorizonKey>('60')
const selectedStationId = ref('')
const sourceMode = ref<SourceMode>('live')
const livePayload = ref<LiveResponse | null>(null)
const livePending = ref(false)
const liveError = ref('')
const liveUpdateState = ref<'idle' | 'updated'>('idle')
const horizonOptions: HorizonKey[] = ['30', '60', '120']

let livePollTimer: ReturnType<typeof setInterval> | undefined
let livePollStartTimer: ReturnType<typeof setTimeout> | undefined
let liveUpdateResetTimer: ReturnType<typeof setTimeout> | undefined
let liveSignature = ''

const query = computed(() => ({
  at: selectedAt.value || undefined,
  district: selectedDistrict.value || undefined,
  horizon: horizon.value,
}))

const { data: payload, pending, error, refresh } = await useFetch<ApiEnvelope<DashboardArtifact>>('/api/v1/command-center', { query })
const dashboard = computed(() => payload.value?.data)
const meta = computed(() => payload.value?.meta)

function liveStationForecast(station: LiveStation): Forecast {
  const empty = station.currentState === 'empty_now'
  const full = station.currentState === 'full_now'
  const unavailable = station.currentState === 'unavailable'
  const riskScore = unavailable ? 1 : (empty || full ? 0.92 : 0)
  const level = unavailable || empty || full ? 'critical' : 'normal'
  const reasons = unavailable
    ? ['官方即時資料顯示站點暫停或無可用庫存。', '即時模式不產生未來預測；請切換到歷史預測檢視風險。']
    : empty
      ? ['官方即時資料顯示目前無車可借。', '即時模式不產生未來預測；請切換到歷史預測檢視風險。']
      : full
        ? ['官方即時資料顯示目前無位可還。', '即時模式不產生未來預測；請切換到歷史預測檢視風險。']
        : ['官方即時資料顯示庫存正常。', '即時模式不產生未來預測；請切換到歷史預測檢視風險。']

  return {
    predictedBikes: station.availableBikes,
    predictedDocks: station.availableDocks,
    emptyRisk: empty || unavailable ? 1 : 0,
    fullRisk: full || unavailable ? 1 : 0,
    riskScore,
    level,
    confidence: 'low',
    reasons,
  }
}

function createLiveDashboard(response: LiveResponse): DashboardArtifact {
  const stations: StationRisk[] = response.data.stations.map((station) => {
    const forecast = liveStationForecast(station)
    return {
      id: station.id,
      name: station.name,
      city: '新北市',
      district: station.district,
      latitude: station.latitude,
      longitude: station.longitude,
      totalDocks: station.totalDocks,
      availableBikes: station.availableBikes,
      availableDocks: station.availableDocks,
      capacityGap: station.capacityGap,
      currentState: station.currentState,
      qualityFlags: station.active ? [] : ['官方資料標示為未啟用或暫停站點。'],
      forecast: { horizons: { 30: forecast, 60: forecast, 120: forecast } },
    }
  })
  const emptyNow = stations.filter(station => station.currentState === 'empty_now').length
  const fullNow = stations.filter(station => station.currentState === 'full_now').length
  const unavailableNow = stations.filter(station => station.currentState === 'unavailable').length

  return {
    meta: {
      asOf: response.meta.asOf,
      generatedAt: response.meta.generatedAt,
      dataMode: 'live',
      modelVersion: 'ntpc-live-inventory-v1',
      coverage: {
        sourceRows: stations.length,
        sourceFiles: 1,
        stationCount: stations.length,
        dateRange: { from: response.meta.asOf, to: response.meta.asOf },
      },
      quality: {
        unavailableRate: stations.length ? unavailableNow / stations.length : 0,
        capacityMismatchRate: stations.length ? stations.filter(station => station.capacityGap !== 0).length / stations.length : 0,
        notes: ['資料來源：新北市政府 Open Data。即時模式僅呈現當下庫存，未套用預測模型。'],
      },
    },
    availableTimes: [],
    districts: [...new Set(stations.map(station => station.district).filter(Boolean))].sort((left, right) => left.localeCompare(right, 'zh-Hant')),
    summary: {
      totalStations: stations.length,
      emptyNow,
      fullNow,
      unavailableNow,
      highRiskNext60m: emptyNow + fullNow + unavailableNow,
      persistentAlerts: 0,
      recommendedMoves: 0,
    },
    stations,
    alerts: [],
    dispatches: [],
    briefingFacts: [],
    stationHistories: {},
  }
}

function snapshotSignature(response: LiveResponse) {
  return `${response.meta.asOf}|${response.data.stations.map(station => `${station.id}:${station.availableBikes}:${station.availableDocks}:${station.currentState}`).join('|')}`
}

async function refreshLive(options: { manual?: boolean; selectionChanged?: boolean; forceRefresh?: boolean } = {}) {
  if (livePending.value) return
  livePending.value = true
  liveError.value = ''
  try {
    const response = await $fetch<LiveResponse>('/api/v1/live-stations', {
      query: {
        ...(selectedDistrict.value ? { district: selectedDistrict.value } : {}),
        ...(options.forceRefresh ? { refresh: '1' } : {}),
      },
    })
    const nextSignature = snapshotSignature(response)
    const hasPreviousSnapshot = Boolean(livePayload.value)
    const changed = hasPreviousSnapshot && nextSignature !== liveSignature
    if (!hasPreviousSnapshot || changed || options.selectionChanged) livePayload.value = response
    liveSignature = nextSignature

    if (changed && !options.selectionChanged) {
      liveUpdateState.value = 'updated'
      if (liveUpdateResetTimer) clearTimeout(liveUpdateResetTimer)
      liveUpdateResetTimer = setTimeout(() => { liveUpdateState.value = 'idle' }, 6_000)
    }
  } catch {
    liveError.value = options.manual
      ? '官方即時資料暫時無法取得，請稍後再試。'
      : '自動比對官方即時資料失敗，畫面保留上一筆成功資料。'
  } finally {
    livePending.value = false
  }
}

function startLivePolling() {
  if (livePollTimer || livePollStartTimer) return
  // The source publishes on five-minute cadence. Fetch once immediately, then align checks just after each boundary.
  const delayToNextCheck = LIVE_POLL_INTERVAL_MS - (Date.now() % LIVE_POLL_INTERVAL_MS) + 2_000
  livePollStartTimer = setTimeout(() => {
    livePollStartTimer = undefined
    void refreshLive({ forceRefresh: true })
    livePollTimer = setInterval(() => { void refreshLive({ forceRefresh: true }) }, LIVE_POLL_INTERVAL_MS)
  }, delayToNextCheck)
}

function stopLivePolling() {
  if (livePollTimer) {
    clearInterval(livePollTimer)
    livePollTimer = undefined
  }
  if (livePollStartTimer) {
    clearTimeout(livePollStartTimer)
    livePollStartTimer = undefined
  }
}

const liveDashboard = computed(() => livePayload.value ? createLiveDashboard(livePayload.value) : undefined)
const activeDashboard = computed(() => sourceMode.value === 'live' ? liveDashboard.value : dashboard.value)
const activeMeta = computed(() => sourceMode.value === 'live' ? livePayload.value?.meta : meta.value)
const activePending = computed(() => sourceMode.value === 'live' ? livePending.value : pending.value)
const activeError = computed(() => sourceMode.value === 'live' ? liveError.value : error.value)

watch(activeDashboard, (value) => {
  if (!value) return
  if (sourceMode.value === 'historical_replay' && !selectedAt.value) selectedAt.value = meta.value?.asOf || value.meta.asOf
  if (!selectedStationId.value || !value.stations.some(station => station.id === selectedStationId.value)) {
    selectedStationId.value = value.stations[0]?.id || ''
  }
}, { immediate: true })

watch(sourceMode, (mode) => {
  if (mode === 'live') {
    void refreshLive()
    startLivePolling()
  } else {
    stopLivePolling()
  }
})

watch([selectedAt, selectedDistrict, horizon], () => {
  if (sourceMode.value === 'live') {
    void refreshLive({ selectionChanged: true })
    return
  }
  void refresh()
})

onBeforeUnmount(() => {
  stopLivePolling()
  if (liveUpdateResetTimer) clearTimeout(liveUpdateResetTimer)
})

onMounted(() => {
  if (sourceMode.value === 'live') {
    void refreshLive()
    startLivePolling()
  }
})

const selectedStation = computed<StationRisk | null>(() => activeDashboard.value?.stations.find(station => station.id === selectedStationId.value) || null)
const selectedHistory = computed(() => sourceMode.value === 'historical_replay' && selectedStationId.value ? activeDashboard.value?.stationHistories[selectedStationId.value] || [] : [])
const dateOptions = computed(() => dashboard.value?.availableTimes || [])
const districtOptions = computed(() => activeDashboard.value?.districts || dashboard.value?.districts || [])
const asOfLabel = computed(() => {
  const date = activeMeta.value?.asOf || activeDashboard.value?.meta.asOf
  if (!date) return '載入中'
  return new Intl.DateTimeFormat('zh-TW', { month: 'long', day: 'numeric', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(date))
})

const metricCards = computed(() => {
  const summary = activeDashboard.value?.summary
  if (!summary) return []
  if (sourceMode.value === 'live') {
    return [
      { label: '即時無車可借', value: summary.emptyNow, caption: '官方來源目前庫存', icon: 'solar:wheel-angle-outline', tone: 'critical' as const },
      { label: '即時無位可還', value: summary.fullNow, caption: '官方來源目前庫存', icon: 'solar:garage-outline', tone: 'warning' as const },
      { label: '暫停／無資料', value: summary.unavailableNow, caption: '需由營運端確認', icon: 'solar:danger-triangle-outline', tone: 'warning' as const },
      { label: '已接入站點', value: summary.totalStations, caption: '新北市官方即時站況', icon: 'solar:map-point-wave-outline', tone: 'positive' as const },
    ]
  }
  return [
    { label: '無車可借', value: summary.emptyNow, caption: '即刻需處理站點', icon: 'solar:wheel-angle-outline', tone: 'critical' as const },
    { label: '無位可還', value: summary.fullNow, caption: '即刻需處理站點', icon: 'solar:garage-outline', tone: 'warning' as const },
    { label: '60 分鐘高風險', value: summary.highRiskNext60m, caption: '預判後主動介入', icon: 'solar:graph-up-outline', tone: 'warning' as const },
    { label: '建議搬運', value: summary.recommendedMoves, caption: '等待人工指派', icon: 'solar:routing-2-outline', tone: 'positive' as const },
  ]
})

const modeLead = computed(() => sourceMode.value === 'live' ? '用官方即時資料，' : '在失衡發生前，')
const modeAccent = computed(() => sourceMode.value === 'live' ? '掌握此刻庫存。' : '先看見、再派車。')
const modeDescription = computed(() => sourceMode.value === 'live'
  ? '同步新北市政府 Open Data 的各站可借車與可還位；每 5 分鐘比對一次，資料來源更新後才會替換畫面。'
  : '以六個月站點快照計算空車／滿位風險，將需要介入的站點轉成可覆核的調度任務。')

async function acknowledge(alertId: string) {
  await $fetch(`/api/v1/alerts/${alertId}/ack`, { method: 'POST' })
  await refresh()
}

async function acceptDispatch(dispatchId: string) {
  await $fetch(`/api/v1/dispatches/${dispatchId}/accept`, { method: 'POST' })
  await refresh()
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
        <p class="eyebrow"><span class="live-dot" /> {{ sourceMode === 'live' ? '新北市政府官方即時站況' : '可重現的歷史回放情境' }}</p>
        <h2>{{ modeLead }}<em>{{ modeAccent }}</em></h2>
        <p>{{ modeDescription }}</p>
      </div>
      <div class="intro-data-note">
        <span><Icon icon="solar:database-outline" /> {{ sourceMode === 'live' ? '官方資料時間' : '資料時間' }}</span>
        <strong>{{ asOfLabel }}</strong>
        <small>{{ sourceMode === 'live' ? '即時庫存 · 每 5 分鐘比對' : `歷史回放 · ${activeMeta?.forecastModel || '載入中'}` }}</small>
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
        <span>回放時間</span>
        <select v-model="selectedAt">
          <option v-for="time in dateOptions" :key="time" :value="time">{{ new Intl.DateTimeFormat('zh-TW', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(time)) }}</option>
        </select>
      </label>
      <label>
        <span>行政區</span>
        <select v-model="selectedDistrict">
          <option value="">全部行政區</option>
          <option v-for="district in districtOptions" :key="district" :value="district">{{ district }}</option>
        </select>
      </label>
      <div v-if="sourceMode === 'historical_replay'" class="horizon-switch" role="group" aria-label="預測時間窗">
        <span>預測時間窗</span>
        <div>
          <button v-for="item in horizonOptions" :key="item" type="button" :class="{ active: horizon === item }" @click="horizon = item">{{ item }}m</button>
        </div>
      </div>
      <button v-else class="live-refresh-button" type="button" :disabled="livePending" @click="refreshLive({ manual: true })">
        <Icon :icon="livePending ? 'svg-spinners:3-dots-fade' : 'solar:refresh-circle-outline'" />
        {{ livePending ? '比對中' : '立即比對' }}
      </button>
      <div class="control-note">
        <Icon :icon="sourceMode === 'live' ? 'solar:refresh-circle-outline' : 'solar:shield-warning-outline'" />
        {{ sourceMode === 'live' ? (liveUpdateState === 'updated' ? '偵測到官方資料更新，畫面已同步。' : '每 5 分鐘比對一次；資料變更才更新畫面。') : '風險分數不是租借量預測' }}
      </div>
    </section>

    <section v-if="activeDashboard" class="metric-grid" aria-label="營運重點指標">
      <MetricCard v-for="card in metricCards" :key="card.label" v-bind="card" />
    </section>

    <div v-if="activePending && !activeDashboard" class="loading-board"><Icon icon="svg-spinners:3-dots-fade" />{{ sourceMode === 'live' ? '正在比對官方即時站況…' : '正在整理調度情境…' }}</div>
    <div v-else-if="activeError && !activeDashboard" class="loading-board error-board"><Icon icon="solar:danger-triangle-outline" />{{ sourceMode === 'live' ? '官方即時資料暫時無法回應，請稍後重試。' : '資料服務暫時無法回應，請執行資料產製流程後再試。' }}</div>

    <template v-else-if="activeDashboard">
      <p v-if="sourceMode === 'live' && liveError" class="live-inline-error"><Icon icon="solar:danger-triangle-outline" /> {{ liveError }}</p>
      <section class="dashboard-grid primary-grid">
        <RiskMap :stations="activeDashboard.stations" :horizon="horizon" :selected-id="selectedStationId" :data-mode="sourceMode" @select="selectStation" />
        <StationDetailPanel :station="selectedStation" :history="selectedHistory" :horizon="horizon" :data-mode="sourceMode" @close="selectedStationId = ''" />
      </section>

      <template v-if="sourceMode === 'historical_replay'">
        <section class="dashboard-grid operations-grid">
          <AlertList :alerts="activeDashboard.alerts" :stations="activeDashboard.stations" compact @select="selectStation" @acknowledge="acknowledge" />
          <DispatchList :dispatches="activeDashboard.dispatches" :stations="activeDashboard.stations" compact @select="selectStation" @accept="acceptDispatch" />
        </section>
        <BriefingCard :as-of="activeMeta?.asOf || activeDashboard.meta.asOf" :horizon="horizon" :district="selectedDistrict" />
        <section class="data-footnote">
          <Icon icon="solar:info-circle-outline" />
          <span>資料共 {{ activeDashboard.meta.coverage.sourceRows.toLocaleString() }} 筆站點快照；原始資料未進入前端。可借車與可還位同時為 0 的站點會標為「暫不可用」，不會誤判成雙重需求。</span>
        </section>
      </template>
      <template v-else>
        <LiveFeedCard :district="selectedDistrict" :payload="livePayload" :pending="livePending" :error-message="liveError" :updated="liveUpdateState === 'updated'" @refresh="refreshLive({ manual: true })" />
        <section class="data-footnote">
          <Icon icon="solar:info-circle-outline" />
          <span>即時模式僅反映官方來源當下庫存，不混入預測值；如要判讀未來 30／60／120 分鐘風險，請切換至「歷史預測」。</span>
        </section>
      </template>
    </template>
  </div>
</template>
