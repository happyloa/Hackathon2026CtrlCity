import { configureSnapshotPersistence } from '~/composables/useStationSnapshots'
import type { StationPersistence } from '~/shared/station-persistence'
import { stationStatusDurationMinutes } from '~/shared/station-overview'
import { buildLiveOperations } from '~/shared/live-operations'
import { lowBikesPersistedIds } from '~/composables/useLiveRiskProfiles'
import { frozenStationIds } from '~/composables/useFrozenStations'
import type {
  Alert,
  DashboardArtifact,
  DashboardSummary,
  DispatchRecommendation,
  Forecast,
  HorizonKey,
  LiveStation,
  PredictionCoverage,
  StationRisk,
} from '~/shared/ops'

import { createLiveResponse, type LiveResponse } from '~/shared/live-feed'
export type { LiveResponse } from '~/shared/live-feed'

type LiveProfilePolicy = {
  riskPolicy: {
    version: string
    alertThresholds: Record<HorizonKey, number>
  }
} | null

let updateResetTimer: ReturnType<typeof setTimeout> | undefined

function fallbackForecast(station: LiveStation, horizon: HorizonKey, observedAt: string): Forecast {
  return {
    targetAt: new Date((Date.parse(observedAt) || Date.now()) + Number(horizon) * 60_000).toISOString(),
    baselineBikes: null,
    baselineDocks: null,
    predictedBikes: station.availableBikes,
    predictedDocks: station.availableDocks,
    emptyRisk: 0,
    fullRisk: 0,
    unavailableRisk: station.serviceStatus === 'operational' ? 0 : 1,
    riskScore: 0,
    level: 'normal',
    confidence: 'low',
    alertThreshold: .45,
    baselineStatus: station.serviceStatus === 'operational' ? 'unmatched' : 'not_applicable',
    baselineCoverage: station.serviceStatus === 'operational' ? 'unmatched' : 'not_applicable',
    method: 'inventory_only',
    sampleSize: 0,
    reasons: ['尚未取得歷史資料，目前只顯示即時庫存。'],
  }
}

function qualityFlagsFor(station: LiveStation, forecasts: Record<HorizonKey, Forecast>) {
  const flags: string[] = []
  if (station.serviceStatus === 'official_inactive') {
    flags.push('官方標示停用，已排除預測與路線。')
  } else if (station.serviceStatus === 'suspected_unavailable') {
    flags.push('可借與可還都是 0，可能是服務或資料異常；已排除路線。')
  }
  if (station.serviceStatus === 'operational' && forecasts['60'].baselineStatus === 'unmatched') {
    flags.push('找不到可用的歷史資料，不做 60 分鐘預估。')
  }
  if (station.capacityGap !== 0) flags.push('庫存與總車柱不一致，請以官方資料為準。')
  return flags
}

export function summarize(stations: StationRisk[], alerts: Alert[], dispatches: DispatchRecommendation[]): DashboardSummary {
  return {
    totalStations: stations.length,
    emptyNow: stations.filter(station => station.currentState === 'empty_now').length,
    fullNow: stations.filter(station => station.currentState === 'full_now').length,
    unavailableNow: stations.filter(station => station.serviceStatus !== 'operational').length,
    highRiskNext60m: stations.filter((station) => {
      const level = station.forecast.horizons['60'].level
      return station.serviceStatus === 'operational' && (level === 'high' || level === 'critical')
    }).length,
    inventoryAlerts: alerts.filter(alert => alert.condition !== 'unavailable').length,
    recommendedMoves: dispatches.length,
  }
}

export function briefingFacts(summary: DashboardSummary) {
  return [
    { label: '即時庫存風險', value: summary.inventoryAlerts },
    { label: '可行搬運建議', value: summary.recommendedMoves },
    { label: '60 分鐘高風險站', value: summary.highRiskNext60m },
  ]
}

function createLiveDashboard(
  response: LiveResponse,
  forecastByStation: Map<string, Record<HorizonKey, Forecast>>,
  riskPolicy: LiveProfilePolicy,
  realtimeLowBikes: { atLeast30: string[]; atLeast60: string[] },
  frozenStations: { stationId: string; metric: 'bikes' | 'docks'; stuckValue: number }[],
  persistence: { lookup: (id: string) => StationPersistence | null },
): DashboardArtifact {
  const stations: StationRisk[] = response.data.stations.map((station) => {
    const forecasts = forecastByStation.get(station.id) || {
      '30': fallbackForecast(station, '30', response.meta.asOf),
      '60': fallbackForecast(station, '60', response.meta.asOf),
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
  const { snapshotsFor } = useStationSnapshots()
  for (const station of stations) {
    station.statusDurationMinutes = stationStatusDurationMinutes(station, snapshotsFor(station.id), Date.now())
  }
  for (const station of stations) {
    const carried = persistence.lookup(station.id)
    if (carried && carried.currentState === station.currentState
      && carried.last[0] === station.availableBikes && carried.last[1] === station.availableDocks) {
      station.statusDurationMinutes = carried.stateMinutes
      const hour = new Date(Date.parse(response.meta.asOf) + 8 * 3600000).getUTCHours()
      if (hour >= 6 && carried.unchangedMinutes >= 180) station.qualityFlags.push(`疑似壞車／感測異常：庫存已 ${Math.floor(carried.unchangedMinutes / 60)} 小時未變化，請現場查驗。`)
    }
  }
  const plan = buildLiveOperations(stations, response.meta.asOf)
  const summary = summarize(stations, plan.alerts, plan.dispatches)

  return {
    meta: {
      asOf: response.meta.asOf,
      generatedAt: response.meta.generatedAt,
      dataMode: 'live',
      modelVersion: riskPolicy ? 'historical-live-inventory-baseline-v2' : 'ntpc-live-inventory-v1',
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
          '資料來源：新北市政府 Open Data。',
          riskPolicy
            ? '用即時庫存和同站歷史資料估算 60 分鐘站況；分數只用來排序。'
            : '歷史資料暫不可用，目前只顯示即時庫存。',
          '平台只提供分析與路線建議，不會派車。',
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
    realtimeLowBikes,
    frozenStations,
  }
}

function snapshotSignature(response: LiveResponse) {
  return `${response.meta.asOf}|${response.data.stations.map(station => `${station.id}:${station.availableBikes}:${station.availableDocks}:${station.currentState}:${station.serviceStatus}`).join('|')}`
}

function profileSignature(error: string, coverage: PredictionCoverage | null) {
  if (!coverage) return `pending:${error}`
  return [
    error,
    coverage.asOf,
    coverage.historicalProfileStations,
    coverage.matchedStations,
    coverage.unmatchedStations,
    coverage.ambiguousStationMatches,
    coverage.notApplicableStations,
  ].join('|')
}

function scopedDashboard(dashboard: DashboardArtifact | null, district: string): DashboardArtifact | null {
  if (!dashboard) return null
  const stations = district ? dashboard.stations.filter(station => station.district === district) : dashboard.stations
  const plan = district
    ? buildLiveOperations(stations, dashboard.meta.asOf)
    : { alerts: dashboard.alerts, dispatches: dashboard.dispatches }
  const alerts = plan.alerts
  const dispatches = plan.dispatches
  const summary = summarize(stations, alerts, dispatches)
  const stationIds = district ? new Set(stations.map(station => station.id)) : null
  const realtimeLowBikes = stationIds && dashboard.realtimeLowBikes
    ? {
        atLeast30: dashboard.realtimeLowBikes.atLeast30.filter(id => stationIds.has(id)),
        atLeast60: dashboard.realtimeLowBikes.atLeast60.filter(id => stationIds.has(id)),
      }
    : dashboard.realtimeLowBikes
  const frozenStations = stationIds && dashboard.frozenStations
    ? dashboard.frozenStations.filter(entry => stationIds.has(entry.stationId))
    : dashboard.frozenStations
  return {
    ...dashboard,
    summary,
    stations,
    alerts,
    dispatches,
    briefingFacts: briefingFacts(summary),
    realtimeLowBikes,
    frozenStations,
  }
}

export function useLiveDashboard() {
  const liveStationsEndpoint = String(useRuntimeConfig().public.liveStationsEndpoint || '/api/v1/live-stations')
  const snapshotPath = String(useRuntimeConfig().public.liveSnapshotPath || '')
  const persistence = useStationPersistence()
  configureSnapshotPersistence(useRuntimeConfig().public.storageMode !== 'aws' && !useRuntimeConfig().public.persistencePath)
  async function loadRawStations(): Promise<unknown> {
    if (snapshotPath) {
      try {
        const result = await $fetch.raw<unknown>(snapshotPath, { cache: 'no-store', timeout: 10000, retry: 0 })
        const modified = Date.parse(result.headers.get('last-modified') || '')
        const sourceTimes = Array.isArray(result._data) && result._data.some(row => /^\d{8}T\d{6}$/.test(row?.mday))
        const sourceAge = sourceTimes ? Date.now() - Date.parse(createLiveResponse(result._data).meta.asOf) : Infinity
        const objectAge = Date.now() - modified
        if (objectAge >= -60000 && objectAge < 15 * 60000 && sourceAge >= -60000 && sourceAge < 15 * 60000) return result._data
      } catch { /* Missing, malformed or stale snapshots fall back to the live proxy. */ }
    }
    return $fetch(liveStationsEndpoint, { cache: 'no-store', timeout: 20000, retry: 0 })
  }
  const payload = useState<LiveResponse | null>('live-dashboard-payload', () => null)
  const dashboard = useState<DashboardArtifact | null>('live-dashboard-artifact', () => null)
  const pending = useState('live-dashboard-pending', () => false)
  const error = useState('live-dashboard-error', () => '')
  const updated = useState('live-dashboard-updated', () => false)
  const signature = useState('live-dashboard-signature', () => '')
  const baselineSignature = useState('live-dashboard-baseline-signature', () => '')
  const {
    manifest: profileManifest,
    error: profileError,
    coverage: profileCoverage,
    forecastsFor,
  } = useLiveRiskProfiles()

  async function refresh(options: { manual?: boolean } = {}) {
    if (pending.value) return
    pending.value = true
    error.value = ''
    try {
      const [rawStations] = await Promise.all([loadRawStations(), persistence.refresh()])
      const response = createLiveResponse(rawStations)
      const forecasts = await forecastsFor(response.data.stations, response.meta.asOf, {
        refreshProfiles: Boolean(options.manual),
      })
      // Read after forecastsFor resolves: it records this poll's snapshot for
      // every station internally, so the persistence check below already
      // sees the just-updated buffer, including the current reading.
      const realtimeLowBikes = {
        atLeast30: [...lowBikesPersistedIds(response.data.stations, response.meta.asOf, 30)],
        atLeast60: [...lowBikesPersistedIds(response.data.stations, response.meta.asOf, 60)],
      }
      const frozenStations = [...frozenStationIds(response.data.stations, response.meta.asOf)]
        .map(([stationId, info]) => ({ stationId, ...info }))
      const nextDashboard = createLiveDashboard(response, forecasts, profileManifest.value, realtimeLowBikes, frozenStations, persistence)
      const nextSignature = snapshotSignature(response)
      const nextBaselineSignature = profileSignature(profileError.value, profileCoverage.value)
      const hadPrevious = Boolean(payload.value)
      const changed = hadPrevious && nextSignature !== signature.value
      const baselineChanged = hadPrevious && nextBaselineSignature !== baselineSignature.value
      if (!hadPrevious || changed || baselineChanged || options.manual || snapshotPath) {
        payload.value = response
        dashboard.value = nextDashboard
      }
      signature.value = nextSignature
      baselineSignature.value = nextBaselineSignature

      if (changed) {
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

  function dashboardForDistrict(district = '') {
    return scopedDashboard(dashboard.value, district)
  }

  return {
    payload,
    dashboard,
    pending,
    error,
    updated,
    profileError,
    profileCoverage,
    refresh,
    dashboardForDistrict,
  }
}
