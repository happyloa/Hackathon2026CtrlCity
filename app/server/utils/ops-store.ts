import rawDashboard from '../data/dashboard.json'
import type {
  Alert,
  AlertStatus,
  ApiEnvelope,
  ApiMeta,
  BriefingFact,
  CurrentState,
  DashboardArtifact,
  DashboardScenario,
  DashboardSummary,
  DispatchRecommendation,
  Forecast,
  HorizonKey,
  RiskLevel,
  StationHistoryPoint,
  StationRisk,
} from '~/shared/ops'

type LooseRecord = Record<string, unknown>

interface RawForecast extends LooseRecord {
  predictedBikes?: unknown
  predictedDocks?: unknown
  emptyRisk?: unknown
  fullRisk?: unknown
  unavailableRisk?: unknown
  confidence?: unknown
  reasons?: unknown
}

interface RawStation extends LooseRecord {
  id?: unknown
  name?: unknown
  city?: unknown
  district?: unknown
  latitude?: unknown
  longitude?: unknown
  totalDocks?: unknown
  availableBikes?: unknown
  availableDocks?: unknown
  capacityGap?: unknown
  currentState?: unknown
  qualityFlags?: unknown
  forecast?: { horizons?: Record<string, RawForecast> }
}

interface RawAlert extends LooseRecord {
  id?: unknown
  stationId?: unknown
  severity?: unknown
  type?: unknown
  currentState?: unknown
  risk?: unknown
  message?: unknown
  reasons?: unknown
  startedAt?: unknown
  durationMinutes?: unknown
}

interface RawDispatch extends LooseRecord {
  id?: unknown
  sourceStationId?: unknown
  destinationStationId?: unknown
  suggestedBikes?: unknown
  distanceKm?: unknown
  priority?: unknown
  rationale?: unknown
}

interface RawScenario extends LooseRecord {
  summary?: LooseRecord
  stations?: RawStation[]
  alerts?: RawAlert[]
  dispatches?: RawDispatch[]
  briefingFacts?: unknown
  stationHistories?: Record<string, unknown>
}

interface RawDashboard extends RawScenario {
  meta?: LooseRecord
  availableTimes?: unknown
  districts?: unknown
  scenarios?: Record<string, RawScenario>
}

export interface DashboardQuery {
  at?: string
  district?: string
}

const source = rawDashboard as unknown as RawDashboard
const alertStatuses = new Map<string, AlertStatus>()
const dispatchStatuses = new Map<string, DispatchRecommendation['status']>()
const horizonKeys: HorizonKey[] = ['30', '60', '120']

function asRecord(value: unknown): LooseRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as LooseRecord
    : {}
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback
}

function asNumber(value: unknown, fallback = 0): number {
  const number = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(number) ? number : fallback
}

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? value as T[] : []
}

function clamp(value: number, min = 0, max = 1): number {
  return Math.min(max, Math.max(min, value))
}

function rounded(value: number, decimals = 3): number {
  const factor = 10 ** decimals
  return Math.round(value * factor) / factor
}

function toRiskLevel(score: number): RiskLevel {
  if (score >= 0.75) return 'critical'
  if (score >= 0.5) return 'high'
  if (score >= 0.25) return 'medium'
  return 'normal'
}

function toCurrentState(value: unknown): CurrentState {
  switch (asString(value)) {
    case 'empty':
    case 'empty_now':
      return 'empty_now'
    case 'full':
    case 'full_now':
      return 'full_now'
    case 'unavailable':
      return 'unavailable'
    default:
      return 'normal'
  }
}

function normalizeForecast(raw: RawForecast | undefined, fallback: Pick<StationRisk, 'availableBikes' | 'availableDocks'>): Forecast {
  const value = raw ?? {}
  const emptyRisk = clamp(asNumber(value.emptyRisk))
  const fullRisk = clamp(asNumber(value.fullRisk))
  const unavailableRisk = clamp(asNumber(value.unavailableRisk))
  const riskScore = rounded(Math.max(emptyRisk, fullRisk, unavailableRisk))
  const confidenceValue = clamp(asNumber(value.confidence, 0.5))

  return {
    predictedBikes: Math.max(0, Math.round(asNumber(value.predictedBikes, fallback.availableBikes))),
    predictedDocks: Math.max(0, Math.round(asNumber(value.predictedDocks, fallback.availableDocks))),
    emptyRisk,
    fullRisk,
    riskScore,
    level: toRiskLevel(riskScore),
    confidence: confidenceValue >= 0.65 ? 'high' : confidenceValue >= 0.35 ? 'medium' : 'low',
    reasons: asArray<unknown>(value.reasons).map(reason => asString(reason)).filter(Boolean),
  }
}

function normalizeStation(raw: RawStation): StationRisk {
  const base = {
    availableBikes: Math.max(0, Math.round(asNumber(raw.availableBikes))),
    availableDocks: Math.max(0, Math.round(asNumber(raw.availableDocks))),
  }
  const rawHorizons = asRecord(raw.forecast?.horizons)
  const forecast = {
    horizons: Object.fromEntries(
      horizonKeys.map((horizon) => [horizon, normalizeForecast(rawHorizons[horizon] as RawForecast | undefined, base)]),
    ) as Record<HorizonKey, Forecast>,
  }

  return {
    id: asString(raw.id),
    name: asString(raw.name, '未命名站點'),
    city: asString(raw.city, '新北市'),
    district: asString(raw.district, '未分類'),
    latitude: Number.isFinite(asNumber(raw.latitude, Number.NaN)) ? asNumber(raw.latitude) : null,
    longitude: Number.isFinite(asNumber(raw.longitude, Number.NaN)) ? asNumber(raw.longitude) : null,
    totalDocks: Math.max(0, Math.round(asNumber(raw.totalDocks))),
    availableBikes: base.availableBikes,
    availableDocks: base.availableDocks,
    capacityGap: Math.round(asNumber(raw.capacityGap)),
    currentState: toCurrentState(raw.currentState),
    qualityFlags: asArray<unknown>(raw.qualityFlags).map(flag => asString(flag)).filter(Boolean),
    forecast,
  }
}

function alertCondition(raw: RawAlert, station: StationRisk | undefined): Alert['condition'] {
  const type = asString(raw.type)
  const currentState = station?.currentState ?? toCurrentState(raw.currentState)
  if (type === 'unavailable' || currentState === 'unavailable') return 'unavailable'
  if (type === 'full') return currentState === 'full_now' ? 'full_now' : 'full_forecast'
  return currentState === 'empty_now' ? 'empty_now' : 'empty_forecast'
}

function alertSeverity(raw: RawAlert, riskScore: number): Alert['severity'] {
  const severity = asString(raw.severity)
  if (severity === 'critical' || riskScore >= 0.75) return 'critical'
  if (severity === 'high' || severity === 'warning' || riskScore >= 0.5) return 'high'
  return 'medium'
}

function normalizeAlert(raw: RawAlert, stations: Map<string, StationRisk>, asOf: string): Alert {
  const stationId = asString(raw.stationId)
  const station = stations.get(stationId)
  const riskScore = clamp(asNumber(raw.risk, Math.max(
    station?.forecast.horizons['60'].emptyRisk ?? 0,
    station?.forecast.horizons['60'].fullRisk ?? 0,
  )))
  const reasons = asArray<unknown>(raw.reasons).map(reason => asString(reason)).filter(Boolean)
  const message = asString(raw.message)
  if (message) reasons.unshift(message)
  if (reasons.length === 0) reasons.push('由目前庫存與同時槽歷史風險產生的調度提示。')
  const condition = alertCondition(raw, station)
  const fallbackDuration = condition.endsWith('_now') || condition === 'unavailable' ? 30 : 60
  const rawDuration = Math.round(asNumber(raw.durationMinutes, fallbackDuration))
  const durationMinutes = rawDuration > 0 ? rawDuration : fallbackDuration

  return {
    id: asString(raw.id, `alert_${stationId}`),
    stationId,
    condition,
    severity: alertSeverity(raw, riskScore),
    startedAt: asString(raw.startedAt, asOf),
    durationMinutes,
    riskScore,
    status: alertStatuses.get(asString(raw.id, `alert_${stationId}`)) ?? 'open',
    reasons,
  }
}

function normalizeDispatch(raw: RawDispatch, alerts: Alert[]): DispatchRecommendation {
  const fromStationId = asString(raw.sourceStationId)
  const toStationId = asString(raw.destinationStationId)
  const id = asString(raw.id, `dispatch_${fromStationId}_${toStationId}`)
  const linkedAlert = alerts.find(alert => alert.stationId === toStationId && alert.condition !== 'full_now')
  const priority = asString(raw.priority)
  const rationale = asString(raw.rationale)

  return {
    id,
    alertId: linkedAlert?.id ?? null,
    operation: 'deliver_bikes',
    fromStationId,
    toStationId,
    bikeCount: Math.max(1, Math.round(asNumber(raw.suggestedBikes, 1))),
    distanceKm: Math.max(0, rounded(asNumber(raw.distanceKm), 2)),
    priorityScore: priority === 'high' ? 90 : priority === 'medium' ? 65 : 45,
    reasons: rationale ? [rationale] : ['由鄰近可調度站補足預測短缺。'],
    status: dispatchStatuses.get(id) ?? 'proposed',
    requiresOperatorReview: true,
  }
}

function normalizeHistory(value: unknown): StationHistoryPoint[] {
  return asArray<LooseRecord>(value)
    .map(point => ({
      at: asString(point.at),
      bikes: Math.max(0, Math.round(asNumber(point.bikes))),
      docks: Math.max(0, Math.round(asNumber(point.docks))),
    }))
    .filter(point => point.at)
    .sort((left, right) => Date.parse(left.at) - Date.parse(right.at))
}

function normalizeBriefingFacts(value: unknown, summary: DashboardSummary, alerts: Alert[], dispatches: DispatchRecommendation[]): BriefingFact[] {
  const facts = asArray<unknown>(value)
    .map((fact, index): BriefingFact | null => {
      if (typeof fact === 'string') return { label: `資料依據 ${index + 1}`, value: fact }
      const record = asRecord(fact)
      const label = asString(record.label)
      if (!label) return null
      const rawValue = record.value
      return {
        label,
        value: typeof rawValue === 'string' || typeof rawValue === 'number' ? rawValue : '',
        stationId: asString(record.stationId) || undefined,
        alertId: asString(record.alertId) || undefined,
        dispatchId: asString(record.dispatchId) || undefined,
      }
    })
    .filter((fact): fact is BriefingFact => fact !== null)

  if (facts.length > 0) return facts

  return [
    { label: '高風險站點', value: summary.highRiskNext60m },
    { label: '待處理告警', value: alerts.filter(alert => alert.status === 'open').length },
    { label: '建議調度', value: dispatches.filter(dispatch => dispatch.status === 'proposed').length },
  ]
}

function summarize(stations: StationRisk[], alerts: Alert[], dispatches: DispatchRecommendation[]): DashboardSummary {
  return {
    totalStations: stations.length,
    emptyNow: stations.filter(station => station.currentState === 'empty_now').length,
    fullNow: stations.filter(station => station.currentState === 'full_now').length,
    unavailableNow: stations.filter(station => station.currentState === 'unavailable').length,
    highRiskNext60m: stations.filter((station) => {
      const forecast = station.forecast.horizons['60']
      return forecast.level === 'high' || forecast.level === 'critical'
    }).length,
    persistentAlerts: alerts.filter(alert => alert.status !== 'resolved').length,
    recommendedMoves: dispatches.filter(dispatch => dispatch.status === 'proposed').length,
  }
}

function sourceDateRange(): { from: string; to: string } {
  const coverage = asRecord(source.meta?.coverage)
  const allTimes = asArray<unknown>(source.availableTimes).map(value => asString(value)).filter(Boolean)
  return {
    from: asString(coverage.firstAt, allTimes[0] ?? ''),
    to: asString(coverage.lastAt, allTimes.at(-1) ?? ''),
  }
}

function makeArtifactMeta(asOf: string, stationCount: number): DashboardArtifact['meta'] {
  const rawMeta = asRecord(source.meta)
  const coverage = asRecord(rawMeta.coverage)
  const quality = asRecord(rawMeta.quality)
  const sourceRows = Math.max(0, Math.round(asNumber(coverage.validRows, asNumber(coverage.sourceRows))))
  const unavailableRows = Math.max(0, asNumber(quality.unavailableRowsExcludedFromProfile))
  const capacityGapRows = Math.max(0, asNumber(asRecord(quality.flagCounts).capacity_gap))
  const dataMode = asString(rawMeta.dataMode) === 'live' ? 'live' : 'historical_replay'
  const forecastMethod = asString(rawMeta.forecastMethod)

  return {
    asOf,
    generatedAt: asString(rawMeta.generatedAt, new Date(0).toISOString()),
    dataMode,
    modelVersion: asString(rawMeta.modelVersion, 'historical-profile-heuristic-v1'),
    coverage: {
      sourceRows,
      sourceFiles: Math.max(0, Math.round(asNumber(coverage.sourceFiles))),
      stationCount,
      dateRange: sourceDateRange(),
    },
    quality: {
      unavailableRate: sourceRows ? rounded(unavailableRows / sourceRows) : 0,
      capacityMismatchRate: sourceRows ? rounded(capacityGapRows / sourceRows) : 0,
      notes: [
        '歷史資料重播模式；站點未營運（車與空位同為 0）不列入無車／滿站預測。',
        ...(forecastMethod ? [forecastMethod] : []),
      ],
    },
  }
}

function scenarioKeys(): string[] {
  const keys = Object.keys(source.scenarios ?? {})
  if (keys.length > 0) return keys.sort((left, right) => Date.parse(left) - Date.parse(right))
  const fallback = asString(source.meta?.asOf)
  return fallback ? [fallback] : []
}

function resolveScenario(requestedAt?: string): { asOf: string; scenario: RawScenario } {
  const keys = scenarioKeys()
  const defaultAsOf = asString(source.meta?.asOf, keys.at(-1) ?? '')
  const firstScenario = keys[0] ?? defaultAsOf
  const exact = requestedAt && (source.scenarios?.[requestedAt] ?? (requestedAt === defaultAsOf ? source : undefined))
  if (exact) return { asOf: requestedAt as string, scenario: exact }

  const requestEpoch = requestedAt ? Date.parse(requestedAt) : Number.NaN
  const selected = Number.isFinite(requestEpoch) && keys.length
    ? keys.reduce((nearest, candidate) => Math.abs(Date.parse(candidate) - requestEpoch) < Math.abs(Date.parse(nearest) - requestEpoch) ? candidate : nearest, firstScenario)
    : defaultAsOf

  return { asOf: selected, scenario: source.scenarios?.[selected] ?? source }
}

function buildDashboard(query: DashboardQuery = {}): DashboardArtifact {
  const { asOf, scenario } = resolveScenario(query.at)
  const allStations = asArray<RawStation>(scenario.stations).map(normalizeStation).filter(station => station.id)
  const unfilteredStationMap = new Map(allStations.map(station => [station.id, station]))
  const allAlerts = asArray<RawAlert>(scenario.alerts).map(alert => normalizeAlert(alert, unfilteredStationMap, asOf))
  const allDispatches = asArray<RawDispatch>(scenario.dispatches).map(dispatch => normalizeDispatch(dispatch, allAlerts))
  const district = query.district?.trim()
  const stations = district ? allStations.filter(station => station.district === district) : allStations
  const stationIds = new Set(stations.map(station => station.id))
  const alerts = district ? allAlerts.filter(alert => stationIds.has(alert.stationId)) : allAlerts
  const dispatches = district
    ? allDispatches.filter(dispatch => stationIds.has(dispatch.fromStationId) || stationIds.has(dispatch.toStationId))
    : allDispatches
  const allHistories = asRecord(scenario.stationHistories)
  const stationHistories = Object.fromEntries(stations.map(station => [station.id, normalizeHistory(allHistories[station.id])]))
  const summary = summarize(stations, alerts, dispatches)

  return {
    meta: makeArtifactMeta(asOf, stations.length),
    availableTimes: scenarioKeys(),
    districts: asArray<unknown>(source.districts).map(value => asString(value)).filter(Boolean),
    summary,
    stations,
    alerts,
    dispatches,
    briefingFacts: normalizeBriefingFacts(scenario.briefingFacts, summary, alerts, dispatches),
    stationHistories,
  }
}

export function getDashboard(query: DashboardQuery = {}): DashboardArtifact {
  return buildDashboard(query)
}

export function getApiMeta(dashboard: DashboardArtifact, narrativeProvider: ApiMeta['narrativeProvider'] = 'template'): ApiMeta {
  return {
    asOf: dashboard.meta.asOf,
    generatedAt: dashboard.meta.generatedAt,
    dataMode: dashboard.meta.dataMode,
    forecastModel: dashboard.meta.modelVersion,
    narrativeProvider,
  }
}

export function toEnvelope<T>(data: T, dashboard: DashboardArtifact, narrativeProvider: ApiMeta['narrativeProvider'] = 'template'): ApiEnvelope<T> {
  return { data, meta: getApiMeta(dashboard, narrativeProvider) }
}

export function getStationDetail(stationId: string, at?: string): { dashboard: DashboardArtifact; station: StationRisk; history: StationHistoryPoint[] } | null {
  const dashboard = getDashboard({ at })
  const station = dashboard.stations.find(candidate => candidate.id === stationId)
  if (!station) return null
  return { dashboard, station, history: dashboard.stationHistories[stationId] ?? [] }
}

export function getAlerts(query: DashboardQuery = {}): { dashboard: DashboardArtifact; alerts: Alert[] } {
  const dashboard = getDashboard(query)
  return { dashboard, alerts: dashboard.alerts }
}

export function getDispatches(query: DashboardQuery = {}): { dashboard: DashboardArtifact; dispatches: DispatchRecommendation[] } {
  const dashboard = getDashboard(query)
  return { dashboard, dispatches: dashboard.dispatches }
}

export function acknowledgeAlert(alertId: string): Alert | null {
  const dashboard = getDashboard()
  const alert = dashboard.alerts.find(candidate => candidate.id === alertId)
  if (!alert) return null
  alertStatuses.set(alertId, 'acknowledged')
  return { ...alert, status: 'acknowledged' }
}

export function acceptDispatch(dispatchId: string): DispatchRecommendation | null {
  const dashboard = getDashboard()
  const dispatch = dashboard.dispatches.find(candidate => candidate.id === dispatchId)
  if (!dispatch) return null
  dispatchStatuses.set(dispatchId, 'assigned')
  return { ...dispatch, status: 'assigned' }
}

export function dashboardScenario(query: DashboardQuery = {}): DashboardScenario {
  const dashboard = getDashboard(query)
  return {
    summary: dashboard.summary,
    stations: dashboard.stations,
    alerts: dashboard.alerts,
    dispatches: dashboard.dispatches,
    briefingFacts: dashboard.briefingFacts,
    stationHistories: dashboard.stationHistories,
  }
}
