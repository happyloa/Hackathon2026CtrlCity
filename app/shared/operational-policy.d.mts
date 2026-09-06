export interface OperationalPolicyShape {
  horizon: '60'
  safetyStockRatio: number
  minimumSafetyStock: number
  minimumTransferBikes: number
  maximumTransferBikes: number
  maximumDistanceKm: number
  maximumAlerts: number
  maximumDispatches: number
}

export const DEFAULT_LIVE_OPERATION_POLICY: Readonly<OperationalPolicyShape>
export const ALERT_PRIORITY_THRESHOLDS: Readonly<{ immediate: number; high: number }>

export type SeverityLevel =
  | 'service_disruption'
  | 'full'
  | 'empty'
  | 'near_empty'
  | 'low'
  | 'normal'

export const SEVERITY_LEVELS: Readonly<{
  SERVICE_DISRUPTION: 'service_disruption'
  FULL: 'full'
  EMPTY: 'empty'
  NEAR_EMPTY: 'near_empty'
  LOW: 'low'
  NORMAL: 'normal'
}>

export function safetyStockFor(
  station: { totalDocks: number },
  options?: { safetyStockRatio?: number; minimumSafetyStock?: number },
): number

export function stationSeverityFor(station: {
  serviceStatus: string
  availableBikes: number
  availableDocks: number
  totalDocks: number
}): SeverityLevel

export function refillAmountFor(
  station: { totalDocks: number },
  inventory: number,
  options?: { safetyStockRatio?: number; minimumSafetyStock?: number },
): number

export function scoreAlertPriority(input: {
  riskScore: number
  currentFailure: boolean
  gap: number
  quality: number
}): {
  priorityScore: number
  scoreParts: { forecast: number; current: number; gap: number; quality: number }
}

export function alertDataQuality(
  station: { capacityGap: number },
  forecast: { confidence: 'high' | 'medium' | 'low'; baselineStatus: 'matched' | 'unmatched' | 'not_applicable' },
): number
