<script setup lang="ts">
import { Icon } from '@iconify/vue'
import type {
  ApiEnvelope,
  ApiMeta,
  CurrentState,
  DashboardArtifact,
  Forecast,
  HorizonKey,
  LiveStation,
  LiveStationsPayload,
  ServiceStatus,
  StationRisk,
} from '~/shared/ops'

type SourceMode = 'historical_replay' | 'live'
type LiveResponse = ApiEnvelope<LiveStationsPayload>
type NtpRawStation = Record<string, unknown>

const LIVE_POLL_INTERVAL_MS = 5 * 60 * 1000
const selectedAt = ref('')
const selectedDistrict = ref('')
const horizon = ref<HorizonKey>('60')
const selectedStationId = ref('')
const sourceMode = ref<SourceMode>('live')
const livePayload = ref<LiveResponse | null>(null)
const liveDashboard = ref<DashboardArtifact | null>(null)
const livePending = ref(false)
const liveError = ref('')
const liveUpdateState = ref<'idle' | 'updated'>('idle')
const horizonOptions: HorizonKey[] = ['30', '60', '120']
const liveHorizonOptions: HorizonKey[] = ['30', '60']

let livePollTimer: ReturnType<typeof setInterval> | undefined
let livePollStartTimer: ReturnType<typeof setTimeout> | undefined
let liveUpdateResetTimer: ReturnType<typeof setTimeout> | undefined
let liveSignature = ''

const {
  manifest: replayManifest,
  dashboard: replayArtifact,
  pending: replayPending,
  error: replayError,
  loadScenario,
  acknowledge: acknowledgeReplay,
  acceptDispatch: acceptReplay,
  dashboardForDistrict,
} = useReplayDashboard()

const {
  manifest: liveProfileManifest,
  error: liveProfileError,
  forecastsFor,
} = useLiveRiskProfiles()

function asRecord(value: unknown): NtpRawStation {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as NtpRawStation
    : {}
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback
}

function asNumber(value: unknown, fallback = 0): number {
  const candidate = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(candidate) ? candidate : fallback
}

function asCurrentState(active: boolean, bikes: number, docks: number): CurrentState {
  if (!active || (bikes === 0 && docks === 0)) return 'unavailable'
  if (bikes === 0) return 'empty_now'
  if (docks === 0) return 'full_now'
  return 'normal'
}

function serviceStatusFor(active: boolean, bikes: number, docks: number): ServiceStatus {
  if (!active) return 'official_inactive'
  if (bikes === 0 && docks === 0) return 'suspected_unavailable'
  return 'operational'
}

function mapLiveStation(value: unknown): LiveStation | null {
  const station = asRecord(value)
  const id = asString(station.sno)
  if (!id) return null

  const totalDocks = Math.max(0, Math.round(asNumber(station.tot_quantity)))
  const availableBikes = Math.max(0, Math.round(asNumber(station.sbi_quantity, asNumber(station.sbi))))
  const availableDocks = Math.max(0, Math.round(asNumber(station.bemp)))
  const active = asString(station.act) === '1' || asNumber(station.act) === 1
  const latitude = asNumber(station.lat, Number.NaN)
  const longitude = asNumber(station.lng, Number.NaN)

  return {
    id,
    name: asString(station.sna, '未命名站點'),
    district: asString(station.sarea, '未分類'),
    totalDocks,
    availableBikes,
    availableDocks,
    capacityGap: totalDocks - availableBikes - availableDocks,
    latitude: Number.isFinite(latitude) ? latitude : null,
    longitude: Number.isFinite(longitude) ? longitude : null,
    active,
    currentState: asCurrentState(active, availableBikes, availableDocks),
    serviceStatus: serviceStatusFor(active, availableBikes, availableDocks),
    sourceUpdatedAt: asString(station.mday),
    youbike2Bikes: Math.max(0, Math.round(asNumber(station.yb2_quantity))),
    eBikeBikes: Math.max(0, Math.round(asNumber(station.eyb_quantity))),
    dataMode: 'live',
  }
}

function asOfFromSourceTime(value: string | undefined): string {
  if (value && /^\d{8}T\d{6}$/.test(value)) {
    return value.slice(0, 4) + '-' + value.slice(4, 6) + '-' + value.slice(6, 8) + 'T' + value.slice(9, 11) + ':' + value.slice(11, 13) + ':' + value.slice(13, 15) + '+08:00'
  }
  return new Date().toISOString()
}

function createLiveResponse(payload: unknown, district: string): LiveResponse {
  const allStations = Array.isArray(payload)
    ? payload.map(mapLiveStation).filter((station): station is LiveStation => station !== null)
    : []
  const stations = district ? allStations.filter(station => station.district === district) : allStations
  const sourceUpdatedAt = stations.map(station => station.sourceUpdatedAt).filter(Boolean).sort().at(-1)
  const meta: ApiMeta = {
    asOf: asOfFromSourceTime(sourceUpdatedAt),
    generatedAt: new Date().toISOString(),
    dataMode: 'live',
    forecastModel: 'live-historical-baseline-v1',
    narrativeProvider: 'template',
  }

  return {
    data: {
      dataMode: 'live',
      source: 'ntpc-open-data',
      district: district || null,
      stations,
    },
    meta,
  }
}

function fallbackForecast(station: LiveStation, horizon: HorizonKey): Forecast {
  return {
    predictedBikes: station.availableBikes,
    predictedDocks: station.availableDocks,
    emptyRisk: 0,
    fullRisk: 0,
    unavailableRisk: station.serviceStatus === 'operational' ? 0 : 1,
    riskScore: 0,
    level: 'normal',
    confidence: 'low',
    alertThreshold: horizon === '120' ? .4 : .45,
    baselineStatus: station.serviceStatus === 'operational' ? 'unmatched' : 'not_applicable',
    method: 'inventory_only',
    sampleSize: 0,
    reasons: ['尚未取得歷史基線；僅顯示即時庫存。'],
  }
}

function qualityFlagsFor(station: LiveStation, forecasts: Record<HorizonKey, Forecast>) {
  const flags: string[] = []
  if (station.serviceStatus === 'official_inactive') {
    flags.push('官方資料標示為未啟用；需人工確認。')
  } else if (station.serviceStatus === 'suspected_unavailable') {
    flags.push('可借車與可還位皆為 0，疑似服務異常，需人工確認。')
  }
  if (station.serviceStatus === 'operational' && forecasts['60'].baselineStatus === 'unmatched') {
    flags.push('未對照到唯一的歷史站點基線；未產生未來風險。')
  }
  if (station.capacityGap !== 0) flags.push('即時庫存與總車柱未完全相符，請依官方資料覆核。')
  return flags
}

function createLiveDashboard(
  response: LiveResponse,
  forecastByStation: Map<string, Record<HorizonKey, Forecast>>,
): DashboardArtifact {
  const stations: StationRisk[] = response.data.stations.map((station) => {
    const forecasts = forecastByStation.get(station.id) || {
      '30': fallbackForecast(station, '30'),
      '60': fallbackForecast(station, '60'),
      '120': fallbackForecast(station, '120'),
    }
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
      serviceStatus: station.serviceStatus,
      qualityFlags: qualityFlagsFor(station, forecasts),
      forecast: { horizons: forecasts },
    }
  })
  const emptyNow = stations.filter(station => station.currentState === 'empty_now').length
  const fullNow = stations.filter(station => station.currentState === 'full_now').length
  const unavailableNow = stations.filter(station => station.serviceStatus !== 'operational').length
  const highRiskNext60m = stations.filter((station) => {
    const forecast = station.forecast.horizons['60']
    return station.serviceStatus === 'operational' && (forecast.level === 'high' || forecast.level === 'critical')
  }).length
  const riskPolicy = liveProfileManifest.value?.riskPolicy

  return {
    meta: {
      asOf: response.meta.asOf,
      generatedAt: response.meta.generatedAt,
      dataMode: 'live',
      modelVersion: riskPolicy ? 'live-historical-baseline-v1' : 'ntpc-live-inventory-v1',
      coverage: {
        sourceRows: stations.length,
        sourceFiles: 1,
        stationCount: stations.length,
        dateRange: { from: response.meta.asOf, to: response.meta.asOf },
      },
      riskPolicy: riskPolicy ? {
        version: riskPolicy.version,
        alertThresholds: riskPolicy.alertThresholds,
      } : undefined,
      quality: {
        unavailableRate: stations.length ? unavailableNow / stations.length : 0,
        capacityMismatchRate: stations.length ? stations.filter(station => station.capacityGap !== 0).length / stations.length : 0,
        notes: [
          '資料來源：新北市政府 Open Data；官方資料更新後才替換畫面。',
          riskPolicy
            ? '30／60 分鐘為即時庫存結合同站歷史時段的啟發式風險指標，非校準後事件機率，需人工覆核。'
            : '歷史基線暫不可用，僅顯示即時庫存。',
        ],
      },
    },
    availableTimes: [],
    districts: [...new Set(stations.map(station => station.district).filter(Boolean))].sort((left, right) => left.localeCompare(right, 'zh-Hant')),
    summary: {
      totalStations: stations.length,
      emptyNow,
      fullNow,
      unavailableNow,
      highRiskNext60m,
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
  return `${response.meta.asOf}|${response.data.stations.map(station => `${station.id}:${station.availableBikes}:${station.availableDocks}:${station.currentState}:${station.serviceStatus}`).join('|')}`
}

async function refreshLive(options: { manual?: boolean; selectionChanged?: boolean } = {}) {
  if (livePending.value) return
  livePending.value = true
  liveError.value = ''
  try {
    const rawStations = await $fetch<unknown>('/api/v1/live-stations', { cache: 'no-store' })
    const response = createLiveResponse(rawStations, selectedDistrict.value)
    const forecasts = await forecastsFor(response.data.stations, response.meta.asOf)
    const nextDashboard = createLiveDashboard(response, forecasts)
    const nextSignature = snapshotSignature(response)
    const hasPreviousSnapshot = Boolean(livePayload.value)
    const changed = hasPreviousSnapshot && nextSignature !== liveSignature
    if (!hasPreviousSnapshot || changed || options.selectionChanged || options.manual) {
      livePayload.value = response
      liveDashboard.value = nextDashboard
    }
    liveSignature = nextSignature

    if (changed && !options.selectionChanged) {
      liveUpdateState.value = 'updated'
      if (liveUpdateResetTimer) clearTimeout(liveUpdateResetTimer)
      liveUpdateResetTimer = setTimeout(() => { liveUpdateState.value = 'idle' }, 6_000)
    }
  } catch {
    liveError.value = options.manual
      ? '目前無法更新官方即時資料，已保留上一筆成功載入的資料。'
      : '官方即時資料暫時無法取得，請稍後再試。'
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
    void refreshLive()
    livePollTimer = setInterval(() => { void refreshLive() }, LIVE_POLL_INTERVAL_MS)
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

const historicalDashboard = computed(() => dashboardForDistrict(selectedDistrict.value))
const activeDashboard = computed(() => sourceMode.value === 'live' ? liveDashboard.value || undefined : historicalDashboard.value || undefined)
const activeMeta = computed(() => sourceMode.value === 'live' ? livePayload.value?.meta : historicalDashboard.value?.meta)
const activePending = computed(() => sourceMode.value === 'live' ? livePending.value : replayPending.value)
const activeError = computed(() => sourceMode.value === 'live' ? liveError.value : replayError.value)

watch(activeDashboard, (value) => {
  if (!value) return
  if (sourceMode.value === 'historical_replay' && !selectedAt.value) selectedAt.value = value.meta.asOf
  if (!selectedStationId.value || !value.stations.some(station => station.id === selectedStationId.value)) {
    selectedStationId.value = value.stations[0]?.id || ''
  }
}, { immediate: true })

watch(sourceMode, (mode) => {
  if (mode === 'live') {
    if (horizon.value === '120') horizon.value = '60'
    void refreshLive()
    startLivePolling()
  } else {
    stopLivePolling()
    void loadScenario(selectedAt.value || undefined)
  }
})

watch(selectedAt, () => {
  if (sourceMode.value === 'historical_replay' && selectedAt.value !== replayArtifact.value?.meta.asOf) {
    void loadScenario(selectedAt.value)
  }
})

watch(selectedDistrict, () => {
  if (sourceMode.value === 'live') void refreshLive({ selectionChanged: true })
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
const dateOptions = computed(() => replayManifest.value?.availableTimes || replayArtifact.value?.availableTimes || [])
const districtOptions = computed(() => activeDashboard.value?.districts || replayManifest.value?.districts || [])
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
      { label: '待人工確認', value: summary.unavailableNow, caption: '官方未啟用或疑似異常', icon: 'solar:danger-triangle-outline', tone: 'warning' as const },
      { label: '60 分鐘風險', value: summary.highRiskNext60m, caption: '歷史基線啟發式指標', icon: 'solar:graph-up-outline', tone: 'positive' as const },
    ]
  }
  return [
    { label: '目前無車', value: summary.emptyNow, caption: '歷史回放當下狀態', icon: 'solar:wheel-angle-outline', tone: 'critical' as const },
    { label: '目前無位', value: summary.fullNow, caption: '歷史回放當下狀態', icon: 'solar:garage-outline', tone: 'warning' as const },
    { label: '60 分鐘高風險', value: summary.highRiskNext60m, caption: '依驗證門檻篩選', icon: 'solar:graph-up-outline', tone: 'warning' as const },
    { label: '建議任務', value: summary.recommendedMoves, caption: '補車與移車決策支援', icon: 'solar:routing-2-outline', tone: 'positive' as const },
  ]
})

const modeTitle = computed(() => sourceMode.value === 'live' ? '新北市站點供需總覽' : '新北市歷史調度回放')
const modeDescription = computed(() => sourceMode.value === 'live'
  ? '官方資料更新後，以同站、同時段歷史基線標示 30／60 分鐘庫存風險；未能唯一對照時，只呈現即時庫存。'
  : '選擇一個歷史時點，回看庫存、告警與補車／移車建議；所有建議均需由值班人員覆核。')

function acknowledge(alertId: string) {
  acknowledgeReplay(alertId)
}

function acceptDispatch(dispatchId: string) {
  acceptReplay(dispatchId)
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
        <p class="eyebrow"><span class="live-dot" /> {{ sourceMode === 'live' ? '新北市官方即時資料' : '歷史資料風險回放' }}</p>
        <h2>{{ modeTitle }}</h2>
        <p>{{ modeDescription }}</p>
      </div>
      <div class="intro-data-note">
        <span><Icon icon="solar:calendar-date-outline" /> 資料時間</span>
        <strong>{{ asOfLabel }}</strong>
        <small>{{ sourceMode === 'live' ? '官方約每 5 分鐘更新；資料變更才替換畫面' : `歷史回放 · ${activeDashboard?.meta.modelVersion || '尚未載入'}` }}</small>
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
          <StationDetailPanel :station="selectedStation" :history="selectedHistory" :horizon="horizon" :data-mode="sourceMode" @close="selectedStationId = ''" />
          <LiveFeedCard
            v-if="sourceMode === 'live'"
            :district="selectedDistrict"
            :payload="livePayload"
            :dashboard="liveDashboard"
            :pending="livePending"
            :error-message="liveError"
            :updated="liveUpdateState === 'updated'"
            @refresh="refreshLive({ manual: true })"
            @select="selectStation"
          />
          <template v-else>
            <AlertList :alerts="activeDashboard.alerts" :stations="activeDashboard.stations" compact @select="selectStation" @acknowledge="acknowledge" />
            <DispatchList :dispatches="activeDashboard.dispatches" :stations="activeDashboard.stations" compact @select="selectStation" @accept="acceptDispatch" />
          </template>
        </div>
      </section>

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
          <span>30／60 分鐘為即時庫存結合同站歷史時段的啟發式風險指標，不是校準後事件機率；找不到唯一歷史對照時，系統只顯示即時庫存。</span>
        </section>
      </template>
    </template>
  </div>
</template>
