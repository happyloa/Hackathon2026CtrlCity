export type DataMode = 'historical_replay' | 'live'
export type RiskLevel = 'normal' | 'medium' | 'high' | 'critical'
export type CurrentState = 'normal' | 'empty_now' | 'full_now' | 'unavailable'
export type ServiceStatus = 'operational' | 'official_inactive' | 'suspected_unavailable'
export type AlertStatus = 'open' | 'acknowledged' | 'resolved'
export type HorizonKey = '30' | '60'
export type BaselineCoverage = 'sufficient' | 'limited' | 'unmatched' | 'not_applicable'
export type ForecastMethod = 'historical_replay' | 'historical_baseline_live_inventory' | 'inventory_only'

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
  /** Timestamp that this horizon describes, derived from the source snapshot. */
  targetAt: string
  /** Mean inventory for this station and target half-hour in the historical baseline. */
  baselineBikes: number | null
  baselineDocks: number | null
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
  /** Whether the matched historical slot has enough observations for this baseline. */
  baselineCoverage: BaselineCoverage
  method: ForecastMethod
  sampleSize: number
  reasons: string[]
}

/**
 * Compact metadata shipped with the historical profile manifest. It describes
 * the prediction contract without exposing raw historical station snapshots.
 */
export interface PredictionMetadata {
  schemaVersion: '1.0'
  primaryHorizonMinutes: 60
  objective: 'station_empty_or_full_inventory_risk'
  method: 'historical_station_slot_baseline_plus_live_inventory'
  inputPolicy: readonly ['historical_station_slot_profile', 'current_live_inventory', 'page_session_momentum_optional']
  confidencePolicy: {
    limitedMaxSampleSize: number
    sufficientMinSampleSize: number
    highConfidenceMinSampleSize: number
  }
  coverage: {
    historicalProfileStations: number
    populatedStationSlots: number
  }
}

/** Runtime reconciliation of an official live snapshot against historical profiles. */
export interface PredictionCoverage {
  asOf: string
  primaryHorizonMinutes: 60
  historicalProfileStations: number
  liveStations: number
  matchedStations: number
  unmatchedStations: number
  ambiguousStationMatches: number
  notApplicableStations: number
  matchedRate: number
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
  /** Model risk for the condition, kept separate from operational priority. */
  riskScore: number
  /** Explainable 0-100 ordering score; service anomalies deliberately use 0. */
  priorityScore: number
  scoreParts: {
    forecast: number
    current: number
    gap: number
    quality: number
  }
  dispatchEligible: boolean
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
  inventoryAlerts: number
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
  /**
   * Station ids whose live available-bikes count has stayed below
   * `LIVE_SNAPSHOT_POLICY.lowBikesThreshold` for at least 30/60 continuous
   * minutes, per the browser's own persisted snapshot buffer
   * (`useStationSnapshots.ts`). Live mode only -- absent in replay/historical
   * dashboards, which have no rolling live buffer to draw this from.
   */
  realtimeLowBikes?: {
    atLeast30: string[]
    atLeast60: string[]
  }
  /**
   * Stations where one metric (bikes or docks) has sat at one fixed reading
   * from 0 through `FROZEN_STATION_POLICY.stuckValueCeiling` for at least
   * `minRunMinutes` while the other stayed positive -- "站點連續停滯", the
   * client-side live counterpart to `scripts/detect-frozen-stations.mjs`
   * (loosened for live monitoring; see that policy's doc comment). Live mode
   * only, same buffer dependency as `realtimeLowBikes` above.
   */
  frozenStations?: { stationId: string; metric: 'bikes' | 'docks'; stuckValue: number }[]
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
