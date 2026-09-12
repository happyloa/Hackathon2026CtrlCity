export const SAFETY_STOCK_POLICY: Readonly<{ ratio: number; minimum: number }>

export const LOW_INVENTORY_POLICY: Readonly<{ ratio: number; floor: number }>

export interface LiveOperationPolicyShape {
  horizon: '60'
  safetyStockRatio: number
  minimumSafetyStock: number
  minimumTransferBikes: number
  maximumTransferBikes: number
  maximumDistanceKm: number
  maximumAlerts: number
  maximumDispatches: number
}

export const DEFAULT_LIVE_OPERATION_POLICY: Readonly<LiveOperationPolicyShape>

export interface DispatchRoutePolicyShape {
  vehicleCapacity: number
  maximumTasksPerRoute: number
  maximumStopsPerRoute: number
  maximumRouteDistanceKm: number
  maximumAdjacentTaskDistanceKm: number
  priorityOrderTolerance: number
  safetyStockRatio: number
  minimumSafetyStock: number
}

export const DEFAULT_DISPATCH_ROUTE_POLICY: Readonly<DispatchRoutePolicyShape>

export const ALERT_PRIORITY_THRESHOLDS: Readonly<{ immediate: number; high: number }>

/** Band floors for how long a station has been short; highest minutes first. */
export const SUSTAINED_SHORTAGE_TIERS: readonly Readonly<{ minutes: number; score: number }>[]

export const NEAR_EMPTY_BIKES: number

export const XGBOOST_ALERT_THRESHOLD: number

export const NEARBY_STATION_RADII_METERS: Readonly<{
  neighbourGroup: number
  alternateStationSearch: number
}>

export const ALTERNATE_STATION_SUGGESTION_LIMIT: number

export const DISTRICT_ATTENTION_RATE_THRESHOLDS: Readonly<{ low: number; medium: number }>

export const STABLE_INVENTORY_TONE_RATIO: number

export const XGBOOST_PREDICTION_POLICY: Readonly<{
  neighborRadiusMeters: number
  lowInventoryRatio: number
  lowInventoryFloor: number
  baselineF1RoutingThreshold: number
}>

export const LIVE_SNAPSHOT_POLICY: Readonly<{
  maxSnapshotsPerStation: number
  localStorageRetentionHours: number
  lowBikesThreshold: number
}>

export const FROZEN_STATION_POLICY: Readonly<{ minRunMinutes: number; stuckValueCeiling: number }>
