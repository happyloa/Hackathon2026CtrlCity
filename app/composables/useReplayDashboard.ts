import type {
  Alert,
  DashboardArtifact,
  DashboardSummary,
  DispatchRecommendation,
  StationRisk,
} from '~/shared/ops'

export interface ReplayManifest {
  defaultAsOf: string
  availableTimes: string[]
  districts: string[]
  scenarios: Record<string, string>
  labels: Record<string, string>
}

type ReplayActionState = {
  acknowledgedAlertIds: string[]
  acceptedDispatchIds: string[]
}

const scenarioCache = new Map<string, DashboardArtifact>()
let latestScenarioRequest = 0

function actionKey(asOf: string, id: string) {
  return `${asOf}:${id}`
}

function asManifest(value: unknown): ReplayManifest | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const scenarios = record.scenarios
  if (typeof record.defaultAsOf !== 'string' || !Array.isArray(record.availableTimes) || !Array.isArray(record.districts) || !scenarios || typeof scenarios !== 'object' || Array.isArray(scenarios)) {
    return null
  }

  return {
    defaultAsOf: record.defaultAsOf,
    availableTimes: record.availableTimes.filter((value): value is string => typeof value === 'string'),
    districts: record.districts.filter((value): value is string => typeof value === 'string'),
    scenarios: Object.fromEntries(Object.entries(scenarios).filter((entry): entry is [string, string] => typeof entry[1] === 'string')),
    labels: Object.fromEntries(Object.entries(record.labels && typeof record.labels === 'object' && !Array.isArray(record.labels) ? record.labels : {}).filter((entry): entry is [string, string] => typeof entry[1] === 'string')),
  }
}

function normalizeArtifact(value: DashboardArtifact, manifest: ReplayManifest): DashboardArtifact {
  return {
    ...value,
    meta: {
      ...value.meta,
      dataMode: 'historical_replay',
    },
    availableTimes: manifest.availableTimes,
    districts: manifest.districts,
    stations: Array.isArray(value.stations) ? value.stations : [],
    alerts: Array.isArray(value.alerts) ? value.alerts : [],
    dispatches: Array.isArray(value.dispatches) ? value.dispatches : [],
    briefingFacts: Array.isArray(value.briefingFacts) ? value.briefingFacts : [],
    stationHistories: value.stationHistories && typeof value.stationHistories === 'object' ? value.stationHistories : {},
  }
}

function statusWithClientActions(alert: Alert, asOf: string, actions: ReplayActionState): Alert {
  if (alert.status === 'open' && actions.acknowledgedAlertIds.includes(actionKey(asOf, alert.id))) {
    return { ...alert, status: 'acknowledged' }
  }
  return alert
}

function dispatchWithClientActions(dispatch: DispatchRecommendation, asOf: string, actions: ReplayActionState): DispatchRecommendation {
  if (dispatch.status === 'proposed' && actions.acceptedDispatchIds.includes(actionKey(asOf, dispatch.id))) {
    return { ...dispatch, status: 'assigned' }
  }
  return dispatch
}

function summarize(stations: StationRisk[], alerts: Alert[], dispatches: DispatchRecommendation[], fallback: DashboardSummary): DashboardSummary {
  const highRiskNext60m = stations.filter((station) => {
    const level = station.forecast.horizons['60']?.level
    return level === 'high' || level === 'critical'
  }).length

  return {
    ...fallback,
    totalStations: stations.length,
    emptyNow: stations.filter(station => station.currentState === 'empty_now').length,
    fullNow: stations.filter(station => station.currentState === 'full_now').length,
    unavailableNow: stations.filter(station => station.currentState === 'unavailable').length,
    highRiskNext60m,
    persistentAlerts: alerts.filter(alert => alert.status === 'open').length,
    recommendedMoves: dispatches.filter(dispatch => dispatch.status === 'proposed').length,
  }
}

export function filterReplayDashboard(
  dashboard: DashboardArtifact | null,
  district: string,
  actions: ReplayActionState,
): DashboardArtifact | null {
  if (!dashboard) return null

  const stations = district
    ? dashboard.stations.filter(station => station.district === district)
    : dashboard.stations
  const stationIds = new Set(stations.map(station => station.id))
  const alerts = dashboard.alerts
    .filter(alert => !district || stationIds.has(alert.stationId))
    .map(alert => statusWithClientActions(alert, dashboard.meta.asOf, actions))
  const dispatches = dashboard.dispatches
    .filter(dispatch => !district || (stationIds.has(dispatch.fromStationId) && stationIds.has(dispatch.toStationId)))
    .map(dispatch => dispatchWithClientActions(dispatch, dashboard.meta.asOf, actions))
  const stationHistories = Object.fromEntries(stations.map(station => [station.id, dashboard.stationHistories[station.id] || []]))

  return {
    ...dashboard,
    summary: summarize(stations, alerts, dispatches, dashboard.summary),
    stations,
    alerts,
    dispatches,
    stationHistories,
  }
}

export function useReplayDashboard() {
  const manifest = useState<ReplayManifest | null>('replay-dashboard-manifest', () => null)
  const dashboard = useState<DashboardArtifact | null>('replay-dashboard-artifact', () => null)
  const pending = useState('replay-dashboard-pending', () => false)
  const error = useState('replay-dashboard-error', () => '')
  const selectedAsOf = useState('replay-dashboard-selected-as-of', () => '')
  const acknowledgedAlertIds = useState<string[]>('replay-dashboard-acknowledged-alerts', () => [])
  const acceptedDispatchIds = useState<string[]>('replay-dashboard-accepted-dispatches', () => [])

  const actions = computed<ReplayActionState>(() => ({
    acknowledgedAlertIds: acknowledgedAlertIds.value,
    acceptedDispatchIds: acceptedDispatchIds.value,
  }))

  async function loadManifest(): Promise<ReplayManifest> {
    if (manifest.value) return manifest.value

    const response = await $fetch<unknown>('/data/replay/manifest.json')
    const parsed = asManifest(response)
    if (!parsed) throw new Error('歷史回放索引格式不正確。')
    manifest.value = parsed
    return parsed
  }

  async function loadScenario(requestedAsOf?: string): Promise<DashboardArtifact | null> {
    const requestId = ++latestScenarioRequest
    pending.value = true
    error.value = ''

    try {
      const nextManifest = await loadManifest()
      const preferredAsOf = requestedAsOf || selectedAsOf.value
      const targetAsOf = preferredAsOf && nextManifest.scenarios[preferredAsOf]
        ? preferredAsOf
        : nextManifest.defaultAsOf
      const scenarioUrl = nextManifest.scenarios[targetAsOf]
      if (!scenarioUrl) throw new Error('找不到指定的歷史回放情境。')

      const cached = scenarioCache.get(scenarioUrl)
      const rawArtifact = cached ?? await $fetch<DashboardArtifact>(scenarioUrl)
      const normalized = normalizeArtifact(rawArtifact, nextManifest)
      if (requestId !== latestScenarioRequest) return null
      if (cached) scenarioCache.delete(scenarioUrl)
      scenarioCache.set(scenarioUrl, normalized)
      while (scenarioCache.size > 2) scenarioCache.delete(scenarioCache.keys().next().value as string)
      dashboard.value = normalized
      selectedAsOf.value = targetAsOf
      return normalized
    } catch (caught) {
      if (requestId !== latestScenarioRequest) return null
      dashboard.value = null
      error.value = caught instanceof Error ? caught.message : '無法載入歷史回放資料。'
      return null
    } finally {
      if (requestId === latestScenarioRequest) pending.value = false
    }
  }

  function acknowledge(alertId: string) {
    const key = actionKey(dashboard.value?.meta.asOf || selectedAsOf.value, alertId)
    if (!acknowledgedAlertIds.value.includes(key)) {
      acknowledgedAlertIds.value = [...acknowledgedAlertIds.value, key]
    }
  }

  function acceptDispatch(dispatchId: string) {
    const key = actionKey(dashboard.value?.meta.asOf || selectedAsOf.value, dispatchId)
    if (!acceptedDispatchIds.value.includes(key)) {
      acceptedDispatchIds.value = [...acceptedDispatchIds.value, key]
    }
  }

  function dashboardForDistrict(district = '') {
    return filterReplayDashboard(dashboard.value, district, actions.value)
  }

  return {
    manifest,
    dashboard,
    selectedAsOf,
    pending,
    error,
    actions,
    loadManifest,
    loadScenario,
    acknowledge,
    acceptDispatch,
    dashboardForDistrict,
  }
}
