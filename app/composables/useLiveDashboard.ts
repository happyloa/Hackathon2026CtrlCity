import { buildLiveOperations } from '~/shared/live-operations'
import type {
  Alert,
  ApiEnvelope,
  ApiMeta,
  CurrentState,
  DashboardArtifact,
  DashboardSummary,
  DispatchRecommendation,
  Forecast,
  HorizonKey,
  LiveStation,
  LiveStationsPayload,
  ServiceStatus,
  StationRisk,
} from '~/shared/ops'

export type LiveResponse = ApiEnvelope<LiveStationsPayload>
type NtpRawStation = Record<string, unknown>

type LiveActionState = {
  acknowledgedAlertIds: string[]
  acceptedDispatchIds: string[]
}

type LiveProfilePolicy = {
  riskPolicy: {
    version: string
    alertThresholds: Record<HorizonKey, number>
  }
} | null

let updateResetTimer: ReturnType<typeof setTimeout> | undefined

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
    return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}T${value.slice(9, 11)}:${value.slice(11, 13)}:${value.slice(13, 15)}+08:00`
  }
  return new Date().toISOString()
}

function createLiveResponse(payload: unknown): LiveResponse {
  const stations = Array.isArray(payload)
    ? payload.map(mapLiveStation).filter((station): station is LiveStation => station !== null)
    : []
  if (!stations.length) throw new Error('官方即時資料沒有可辨識的站點。')
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
      district: null,
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

function summarize(stations: StationRisk[], alerts: Alert[], dispatches: DispatchRecommendation[]): DashboardSummary {
  return {
    totalStations: stations.length,
    emptyNow: stations.filter(station => station.currentState === 'empty_now').length,
    fullNow: stations.filter(station => station.currentState === 'full_now').length,
    unavailableNow: stations.filter(station => station.serviceStatus !== 'operational').length,
    highRiskNext60m: stations.filter((station) => {
      const level = station.forecast.horizons['60'].level
      return station.serviceStatus === 'operational' && (level === 'high' || level === 'critical')
    }).length,
    persistentAlerts: alerts.filter(alert => alert.status === 'open').length,
    recommendedMoves: dispatches.filter(dispatch => dispatch.status === 'proposed').length,
  }
}

function withAlertState(alert: Alert, actions: LiveActionState): Alert {
  return alert.status === 'open' && actions.acknowledgedAlertIds.includes(alert.id)
    ? { ...alert, status: 'acknowledged' }
    : alert
}

function withDispatchState(dispatch: DispatchRecommendation, actions: LiveActionState): DispatchRecommendation {
  return dispatch.status === 'proposed' && actions.acceptedDispatchIds.includes(dispatch.id)
    ? { ...dispatch, status: 'assigned' }
    : dispatch
}

function briefingFacts(summary: DashboardSummary) {
  return [
    { label: '即時待確認告警', value: summary.persistentAlerts },
    { label: '即時待覆核搬運', value: summary.recommendedMoves },
    { label: '60 分鐘高風險站', value: summary.highRiskNext60m },
  ]
}

function createLiveDashboard(
  response: LiveResponse,
  forecastByStation: Map<string, Record<HorizonKey, Forecast>>,
  riskPolicy: LiveProfilePolicy,
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
  const plan = buildLiveOperations(stations, response.meta.asOf)
  const summary = summarize(stations, plan.alerts, plan.dispatches)

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
        version: riskPolicy.riskPolicy.version,
        alertThresholds: riskPolicy.riskPolicy.alertThresholds,
      } : undefined,
      quality: {
        unavailableRate: stations.length ? summary.unavailableNow / stations.length : 0,
        capacityMismatchRate: stations.length ? stations.filter(station => station.capacityGap !== 0).length / stations.length : 0,
        notes: [
          '資料來源：新北市政府 Open Data；官方資料更新後才替換畫面。',
          riskPolicy
            ? '30／60 分鐘為即時庫存結合同站歷史時段的啟發式風險指標，非校準後事件機率，需人工覆核。'
            : '歷史基線暫不可用，僅顯示即時庫存。',
          '告警與調度指派只保存在目前瀏覽器工作階段，不會送出真實車隊命令。',
        ],
      },
    },
    availableTimes: [],
    districts: [...new Set(stations.map(station => station.district).filter(Boolean))].sort((left, right) => left.localeCompare(right, 'zh-Hant')),
    summary,
    stations,
    alerts: plan.alerts,
    dispatches: plan.dispatches,
    briefingFacts: briefingFacts(summary),
    stationHistories: {},
  }
}

function snapshotSignature(response: LiveResponse) {
  return `${response.meta.asOf}|${response.data.stations.map(station => `${station.id}:${station.availableBikes}:${station.availableDocks}:${station.currentState}:${station.serviceStatus}`).join('|')}`
}

function scopedDashboard(dashboard: DashboardArtifact | null, district: string, actions: LiveActionState): DashboardArtifact | null {
  if (!dashboard) return null
  const stations = district ? dashboard.stations.filter(station => station.district === district) : dashboard.stations
  const plan = district
    ? buildLiveOperations(stations, dashboard.meta.asOf)
    : { alerts: dashboard.alerts, dispatches: dashboard.dispatches }
  const alerts = plan.alerts.map(alert => withAlertState(alert, actions))
  const dispatches = plan.dispatches.map(dispatch => withDispatchState(dispatch, actions))
  const summary = summarize(stations, alerts, dispatches)
  return {
    ...dashboard,
    summary,
    stations,
    alerts,
    dispatches,
    briefingFacts: briefingFacts(summary),
  }
}

export function useLiveDashboard() {
  const liveStationsEndpoint = String(useRuntimeConfig().public.liveStationsEndpoint || '/api/v1/live-stations')
  const payload = useState<LiveResponse | null>('live-dashboard-payload', () => null)
  const dashboard = useState<DashboardArtifact | null>('live-dashboard-artifact', () => null)
  const pending = useState('live-dashboard-pending', () => false)
  const error = useState('live-dashboard-error', () => '')
  const updated = useState('live-dashboard-updated', () => false)
  const signature = useState('live-dashboard-signature', () => '')
  const acknowledgedAlertIds = useState<string[]>('live-dashboard-acknowledged-alerts', () => [])
  const acceptedDispatchIds = useState<string[]>('live-dashboard-accepted-dispatches', () => [])
  const { manifest: profileManifest, error: profileError, forecastsFor } = useLiveRiskProfiles()

  const actions = computed<LiveActionState>(() => ({
    acknowledgedAlertIds: acknowledgedAlertIds.value,
    acceptedDispatchIds: acceptedDispatchIds.value,
  }))

  async function refresh(options: { manual?: boolean } = {}) {
    if (pending.value) return
    pending.value = true
    error.value = ''
    try {
      const rawStations = await $fetch<unknown>(liveStationsEndpoint, { cache: 'no-store' })
      const response = createLiveResponse(rawStations)
      const forecasts = await forecastsFor(response.data.stations, response.meta.asOf)
      const nextDashboard = createLiveDashboard(response, forecasts, profileManifest.value)
      const nextSignature = snapshotSignature(response)
      const hadPrevious = Boolean(payload.value)
      const changed = hadPrevious && nextSignature !== signature.value
      if (!hadPrevious || changed || options.manual) {
        payload.value = response
        dashboard.value = nextDashboard
      }
      signature.value = nextSignature

      if (changed) {
        acknowledgedAlertIds.value = []
        acceptedDispatchIds.value = []
        updated.value = true
        if (updateResetTimer) clearTimeout(updateResetTimer)
        updateResetTimer = setTimeout(() => { updated.value = false }, 6_000)
      }
    } catch {
      error.value = options.manual
        ? '目前無法更新官方即時資料，已保留上一筆成功載入的資料。'
        : '官方即時資料暫時無法取得，請稍後再試。'
    } finally {
      pending.value = false
    }
  }

  function acknowledge(alertId: string) {
    if (!acknowledgedAlertIds.value.includes(alertId)) acknowledgedAlertIds.value = [...acknowledgedAlertIds.value, alertId]
  }

  function acceptDispatch(dispatchId: string) {
    if (!acceptedDispatchIds.value.includes(dispatchId)) acceptedDispatchIds.value = [...acceptedDispatchIds.value, dispatchId]
  }

  function dashboardForDistrict(district = '') {
    return scopedDashboard(dashboard.value, district, actions.value)
  }

  return {
    payload,
    dashboard,
    pending,
    error,
    updated,
    profileError,
    actions,
    refresh,
    acknowledge,
    acceptDispatch,
    dashboardForDistrict,
  }
}
