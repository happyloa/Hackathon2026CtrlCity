export type DataMode = 'historical_replay' | 'live'
export type RiskLevel = 'normal' | 'medium' | 'high' | 'critical'
export type CurrentState = 'normal' | 'empty_now' | 'full_now' | 'unavailable'
export type ServiceStatus = 'operational' | 'official_inactive' | 'suspected_unavailable'
export type AlertStatus = 'open' | 'acknowledged' | 'resolved'
export type HorizonKey = '30' | '60' | '120'

/** Keeps the official station identifier in data while removing its repeated UI prefix. */
export function displayStationName(name: string, fallback = '未命名站點'): string {
  const source = name.trim()
  if (!source) return fallback

  const display = source
    .replace(/^YouBike\s*2[.．]0(?:\s*[_＿－—–\-:：]\s*|\s+)?/i, '')
    .trim()

  return display || source
}

export interface Forecast {
  predictedBikes: number
  predictedDocks: number
  emptyRisk: number
  fullRisk: number
  unavailableRisk: number
  riskScore: number
  level: RiskLevel
  confidence: 'low' | 'medium' | 'high'
  alertThreshold: number
  baselineStatus: 'matched' | 'unmatched' | 'not_applicable'
  method: 'historical_replay' | 'live_historical_baseline' | 'inventory_only'
  sampleSize: number
  reasons: string[]
}

export interface StationRisk {
  id: string
  name: string
  city: string
  district: string
  latitude: number | null
  longitude: number | null
  totalDocks: number
  availableBikes: number
  availableDocks: number
  capacityGap: number
  currentState: CurrentState
  serviceStatus: ServiceStatus
  qualityFlags: string[]
  forecast: {
    horizons: Record<HorizonKey, Forecast>
  }
}

export interface Alert {
  id: string
  stationId: string
  condition: 'empty_now' | 'full_now' | 'unavailable' | 'empty_forecast' | 'full_forecast'
  severity: Exclude<RiskLevel, 'normal'>
  startedAt: string
  durationMinutes: number
  riskScore: number
  status: AlertStatus
  reasons: string[]
}

export interface DispatchRecommendation {
  id: string
  alertId: string | null
  operation: 'deliver_bikes' | 'remove_bikes'
  fromStationId: string
  toStationId: string
  bikeCount: number
  distanceKm: number
  priorityScore: number
  reasons: string[]
  status: 'proposed' | 'assigned' | 'completed'
  requiresOperatorReview: true
}

export interface DashboardSummary {
  totalStations: number
  emptyNow: number
  fullNow: number
  unavailableNow: number
  highRiskNext60m: number
  persistentAlerts: number
  recommendedMoves: number
}

export interface StationHistoryPoint {
  at: string
  bikes: number
  docks: number
}

export interface LiveStation {
  id: string
  name: string
  district: string
  totalDocks: number
  availableBikes: number
  availableDocks: number
  capacityGap: number
  latitude: number | null
  longitude: number | null
  active: boolean
  currentState: CurrentState
  serviceStatus: ServiceStatus
  sourceUpdatedAt: string
  youbike2Bikes: number
  eBikeBikes: number
  dataMode: 'live'
}

export interface LiveStationsPayload {
  dataMode: 'live'
  source: 'ntpc-open-data'
  district: string | null
  stations: LiveStation[]
}

export interface BriefingFact {
  label: string
  value: string | number
  stationId?: string
  alertId?: string
  dispatchId?: string
}

export interface DashboardArtifact {
  meta: {
    asOf: string
    generatedAt: string
    dataMode: DataMode
    modelVersion: string
    coverage: {
      sourceRows: number
      sourceFiles: number
      stationCount: number
      dateRange: { from: string; to: string }
    }
    riskPolicy?: {
      version: string
      alertThresholds: Record<HorizonKey, number>
    }
    quality: {
      unavailableRate: number
      capacityMismatchRate: number
      notes: string[]
    }
  }
  availableTimes: string[]
  districts: string[]
  summary: DashboardSummary
  stations: StationRisk[]
  alerts: Alert[]
  dispatches: DispatchRecommendation[]
  briefingFacts: BriefingFact[]
  stationHistories: Record<string, StationHistoryPoint[]>
  scenarios?: Record<string, DashboardScenario>
}

export interface DashboardScenario {
  summary: DashboardSummary
  stations: StationRisk[]
  alerts: Alert[]
  dispatches: DispatchRecommendation[]
  briefingFacts: BriefingFact[]
  stationHistories: Record<string, StationHistoryPoint[]>
}

export interface ApiMeta {
  asOf: string
  generatedAt: string
  dataMode: DataMode
  forecastModel: string
  narrativeProvider: 'template' | 'bedrock'
}

export interface ApiEnvelope<T> {
  data: T
  meta: ApiMeta
}
