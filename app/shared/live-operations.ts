import type {
  Alert,
  DispatchRecommendation,
  Forecast,
  HorizonKey,
  StationRisk,
} from './ops'

export interface LiveOperationPolicy {
  horizon: HorizonKey
  safetyStockRatio: number
  minimumSafetyStock: number
  minimumTransferBikes: number
  maximumTransferBikes: number
  maximumDistanceKm: number
  maximumAlerts: number
  maximumDispatches: number
}

export interface LiveOperationPlan {
  alerts: Alert[]
  dispatches: DispatchRecommendation[]
}

type ActionableCondition = 'empty_now' | 'full_now' | 'empty_forecast' | 'full_forecast'
type DispatchOperation = DispatchRecommendation['operation']

interface AlertCandidate {
  alert: Alert
  station: StationRisk
  condition: Alert['condition']
  gap: number
  safetyStock: number
  currentFailure: boolean
}

interface DispatchCandidate {
  station: StationRisk
  distanceKm: number
  available: number
  competingRisk: number
  score: number
}

export const DEFAULT_LIVE_OPERATION_POLICY: Readonly<LiveOperationPolicy> = Object.freeze({
  horizon: '60',
  safetyStockRatio: 0.15,
  minimumSafetyStock: 2,
  minimumTransferBikes: 1,
  maximumTransferBikes: 8,
  maximumDistanceKm: 8,
  maximumAlerts: 80,
  maximumDispatches: 16,
})

const SEVERITY_ORDER: Record<Alert['severity'], number> = {
  medium: 1,
  high: 2,
  critical: 3,
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value))
}

function finiteNumber(value: number, fallback = 0): number {
  return Number.isFinite(value) ? value : fallback
}

function rounded(value: number, digits = 2): number {
  const scale = 10 ** digits
  return Math.round(value * scale) / scale
}

function normalizedPolicy(options: Partial<LiveOperationPolicy>): LiveOperationPolicy {
  const minimumTransferBikes = Math.max(1, Math.round(finiteNumber(
    options.minimumTransferBikes ?? DEFAULT_LIVE_OPERATION_POLICY.minimumTransferBikes,
    DEFAULT_LIVE_OPERATION_POLICY.minimumTransferBikes,
  )))

  return {
    horizon: options.horizon ?? DEFAULT_LIVE_OPERATION_POLICY.horizon,
    safetyStockRatio: clamp(finiteNumber(
      options.safetyStockRatio ?? DEFAULT_LIVE_OPERATION_POLICY.safetyStockRatio,
      DEFAULT_LIVE_OPERATION_POLICY.safetyStockRatio,
    ), 0, 0.5),
    minimumSafetyStock: Math.max(0, Math.round(finiteNumber(
      options.minimumSafetyStock ?? DEFAULT_LIVE_OPERATION_POLICY.minimumSafetyStock,
      DEFAULT_LIVE_OPERATION_POLICY.minimumSafetyStock,
    ))),
    minimumTransferBikes,
    maximumTransferBikes: Math.max(minimumTransferBikes, Math.round(finiteNumber(
      options.maximumTransferBikes ?? DEFAULT_LIVE_OPERATION_POLICY.maximumTransferBikes,
      DEFAULT_LIVE_OPERATION_POLICY.maximumTransferBikes,
    ))),
    maximumDistanceKm: Math.max(0.1, finiteNumber(
      options.maximumDistanceKm ?? DEFAULT_LIVE_OPERATION_POLICY.maximumDistanceKm,
      DEFAULT_LIVE_OPERATION_POLICY.maximumDistanceKm,
    )),
    maximumAlerts: Math.max(0, Math.round(finiteNumber(
      options.maximumAlerts ?? DEFAULT_LIVE_OPERATION_POLICY.maximumAlerts,
      DEFAULT_LIVE_OPERATION_POLICY.maximumAlerts,
    ))),
    maximumDispatches: Math.max(0, Math.round(finiteNumber(
      options.maximumDispatches ?? DEFAULT_LIVE_OPERATION_POLICY.maximumDispatches,
      DEFAULT_LIVE_OPERATION_POLICY.maximumDispatches,
    ))),
  }
}

export function safetyStockFor(
  station: Pick<StationRisk, 'totalDocks'>,
  options: Pick<Partial<LiveOperationPolicy>, 'safetyStockRatio' | 'minimumSafetyStock'> = {},
): number {
  const policy = normalizedPolicy(options)
  const capacity = Math.max(0, Math.round(finiteNumber(station.totalDocks)))
  return Math.min(capacity, Math.max(
    policy.minimumSafetyStock,
    Math.ceil(capacity * policy.safetyStockRatio),
  ))
}

function validCoordinates(station: StationRisk): station is StationRisk & { latitude: number, longitude: number } {
  return typeof station.latitude === 'number'
    && Number.isFinite(station.latitude)
    && station.latitude >= -90
    && station.latitude <= 90
    && typeof station.longitude === 'number'
    && Number.isFinite(station.longitude)
    && station.longitude >= -180
    && station.longitude <= 180
}

export function distanceKmBetween(left: StationRisk, right: StationRisk): number | null {
  if (!validCoordinates(left) || !validCoordinates(right)) return null
  const radians = (degrees: number) => degrees * Math.PI / 180
  const latitudeDelta = radians(right.latitude - left.latitude)
  const longitudeDelta = radians(right.longitude - left.longitude)
  const leftLatitude = radians(left.latitude)
  const rightLatitude = radians(right.latitude)
  const haversine = Math.sin(latitudeDelta / 2) ** 2
    + Math.cos(leftLatitude) * Math.cos(rightLatitude) * Math.sin(longitudeDelta / 2) ** 2
  return 6371.0088 * 2 * Math.atan2(Math.sqrt(haversine), Math.sqrt(Math.max(0, 1 - haversine)))
}

function alertThreshold(forecast: Forecast): number {
  return clamp(finiteNumber(forecast.alertThreshold, 0.45), 0, 1)
}

function severityFor(score: number, forecast: Forecast, currentFailure: boolean): Alert['severity'] {
  if (currentFailure || forecast.level === 'critical' || score >= Math.min(1, alertThreshold(forecast) + 0.2)) {
    return 'critical'
  }
  if (forecast.level === 'high' || score >= alertThreshold(forecast)) return 'high'
  return 'medium'
}

function alertId(observedAt: string, stationId: string, horizon: HorizonKey, condition: Alert['condition']): string {
  return `live-alert:${encodeURIComponent(observedAt)}:${horizon}:${encodeURIComponent(stationId)}:${condition}`
}

function dispatchId(
  observedAt: string,
  operation: DispatchOperation,
  horizon: HorizonKey,
  fromStationId: string,
  toStationId: string,
): string {
  return `live-dispatch:${encodeURIComponent(observedAt)}:${horizon}:${operation}:${encodeURIComponent(fromStationId)}:${encodeURIComponent(toStationId)}`
}

function predictedInventory(station: StationRisk, condition: ActionableCondition, forecast: Forecast): number {
  if (condition === 'empty_now') return Math.min(station.availableBikes, forecast.predictedBikes)
  if (condition === 'full_now') return Math.min(station.availableDocks, forecast.predictedDocks)
  return condition === 'empty_forecast' ? forecast.predictedBikes : forecast.predictedDocks
}

function actionableAlert(
  station: StationRisk,
  observedAt: string,
  policy: LiveOperationPolicy,
): AlertCandidate | null {
  const forecast = station.forecast.horizons[policy.horizon]
  const safetyStock = safetyStockFor(station, policy)

  if (station.serviceStatus !== 'operational' || station.currentState === 'unavailable') {
    const riskScore = clamp(Math.max(finiteNumber(forecast.unavailableRisk), 0.75), 0, 1)
    return {
      station,
      condition: 'unavailable',
      gap: 0,
      safetyStock,
      currentFailure: true,
      alert: {
        id: alertId(observedAt, station.id, policy.horizon, 'unavailable'),
        stationId: station.id,
        condition: 'unavailable',
        severity: 'critical',
        startedAt: observedAt,
        durationMinutes: 0,
        riskScore,
        status: 'open',
        reasons: ['站點目前不是可確認的正常營運狀態，需先由值班人員覆核，不自動產生調度任務。'],
      },
    }
  }

  let condition: ActionableCondition | null = null
  let riskScore = 0
  let currentFailure = false

  if (station.currentState === 'empty_now') {
    condition = 'empty_now'
    riskScore = Math.max(1, finiteNumber(forecast.emptyRisk))
    currentFailure = true
  } else if (station.currentState === 'full_now') {
    condition = 'full_now'
    riskScore = Math.max(1, finiteNumber(forecast.fullRisk))
    currentFailure = true
  } else {
    const emptyRisk = clamp(finiteNumber(forecast.emptyRisk), 0, 1)
    const fullRisk = clamp(finiteNumber(forecast.fullRisk), 0, 1)
    const threshold = alertThreshold(forecast)
    const emptyTriggered = emptyRisk >= threshold
    const fullTriggered = fullRisk >= threshold
    if (!emptyTriggered && !fullTriggered) return null

    if (emptyTriggered && (!fullTriggered || emptyRisk >= fullRisk)) {
      condition = 'empty_forecast'
      riskScore = emptyRisk
    } else {
      condition = 'full_forecast'
      riskScore = fullRisk
    }
  }

  riskScore = clamp(riskScore, 0, 1)
  const inventory = Math.max(0, finiteNumber(predictedInventory(station, condition, forecast)))
  const gap = Math.max(0, Math.ceil(safetyStock - inventory))
  const emptyCondition = condition === 'empty_now' || condition === 'empty_forecast'
  const inventoryLabel = emptyCondition ? '可借車' : '可還位'
  const timingLabel = currentFailure ? '目前' : `${policy.horizon} 分鐘預測`
  const reason = currentFailure
    ? `${timingLabel}${inventoryLabel}已為 0，低於 ${safetyStock} 的安全庫存。`
    : gap > 0
      ? `${timingLabel}${inventoryLabel}為 ${Math.round(inventory)}，低於 ${safetyStock} 的安全庫存；風險指標為 ${Math.round(riskScore * 100)}%。`
      : `${timingLabel}${inventoryLabel}為 ${Math.round(inventory)}；風險指標 ${Math.round(riskScore * 100)}% 已達告警門檻，但預測庫存尚未低於安全庫存。`

  return {
    station,
    condition,
    gap,
    safetyStock,
    currentFailure,
    alert: {
      id: alertId(observedAt, station.id, policy.horizon, condition),
      stationId: station.id,
      condition,
      severity: severityFor(riskScore, forecast, currentFailure),
      startedAt: observedAt,
      durationMinutes: 0,
      riskScore,
      status: 'open',
      reasons: [reason, ...forecast.reasons.slice(0, 2)],
    },
  }
}

function operationFor(condition: ActionableCondition): DispatchOperation {
  return condition === 'empty_now' || condition === 'empty_forecast'
    ? 'deliver_bikes'
    : 'remove_bikes'
}

function candidateRisk(station: StationRisk, operation: DispatchOperation, horizon: HorizonKey): number {
  const forecast = station.forecast.horizons[horizon]
  return clamp(operation === 'deliver_bikes' ? forecast.emptyRisk : forecast.fullRisk, 0, 1)
}

function candidateIsStable(station: StationRisk, operation: DispatchOperation, horizon: HorizonKey): boolean {
  if (station.serviceStatus !== 'operational' || station.currentState !== 'normal') return false
  const forecast = station.forecast.horizons[horizon]
  return candidateRisk(station, operation, horizon) < alertThreshold(forecast)
}

function findDispatchCandidate(
  task: AlertCandidate,
  stations: StationRisk[],
  taskStationIds: Set<string>,
  usedStationIds: Set<string>,
  bikeSupply: Map<string, number>,
  dockSupply: Map<string, number>,
  policy: LiveOperationPolicy,
): DispatchCandidate | null {
  const operation = operationFor(task.condition as ActionableCondition)
  const candidates: DispatchCandidate[] = []

  for (const station of stations) {
    if (station.id === task.station.id || taskStationIds.has(station.id) || usedStationIds.has(station.id)) continue
    if (!candidateIsStable(station, operation, policy.horizon)) continue

    const available = operation === 'deliver_bikes'
      ? bikeSupply.get(station.id) ?? 0
      : dockSupply.get(station.id) ?? 0
    if (available < policy.minimumTransferBikes) continue

    const distanceKm = distanceKmBetween(station, task.station)
    if (distanceKm === null || distanceKm > policy.maximumDistanceKm) continue
    const competingRisk = candidateRisk(station, operation, policy.horizon)
    candidates.push({
      station,
      distanceKm,
      available,
      competingRisk,
      score: distanceKm + competingRisk * 3,
    })
  }

  candidates.sort((left, right) => left.score - right.score
    || left.distanceKm - right.distanceKm
    || left.station.id.localeCompare(right.station.id))
  return candidates[0] ?? null
}

function priorityScore(task: AlertCandidate, distanceKm: number): number {
  const value = task.alert.riskScore * 65
    + Math.min(20, task.gap * 3)
    + (task.currentFailure ? 15 : 0)
    - Math.min(15, distanceKm * 1.5)
  return rounded(clamp(value, 0, 100), 1)
}

function dispatchReasons(
  operation: DispatchOperation,
  task: AlertCandidate,
  candidate: DispatchCandidate,
  bikeCount: number,
  candidateSafetyStock: number,
): string[] {
  const source = operation === 'deliver_bikes' ? candidate.station : task.station
  const destination = operation === 'deliver_bikes' ? task.station : candidate.station
  const inventoryReason = operation === 'deliver_bikes'
    ? `供給站調度後仍保留至少 ${candidateSafetyStock} 輛可借車。`
    : `接收站調度後仍保留至少 ${candidateSafetyStock} 個可還位。`

  return [
    `建議將 ${bikeCount} 輛由「${source.name}」移至「${destination.name}」，處理「${task.station.name}」的 ${task.alert.condition} 告警。`,
    inventoryReason,
    `兩站直線距離約 ${rounded(candidate.distanceKm, 1)} 公里；執行前仍需人工確認道路、載運與現場狀態。`,
  ]
}

/**
 * Produces a deterministic, side-effect-free live operations plan.
 *
 * A station can participate in at most one dispatch in a single plan. Urgent
 * stations are never reused as supply candidates, and every recommendation
 * preserves the configured bike or dock safety stock at the supporting station.
 */
export function buildLiveOperations(
  stations: readonly StationRisk[],
  observedAt: string,
  options: Partial<LiveOperationPolicy> = {},
): LiveOperationPlan {
  if (!observedAt.trim()) throw new TypeError('observedAt must be a non-empty timestamp')
  const policy = normalizedPolicy(options)
  const orderedStations = [...stations].sort((left, right) => left.id.localeCompare(right.id))
  const alertCandidates = orderedStations
    .map(station => actionableAlert(station, observedAt, policy))
    .filter((candidate): candidate is AlertCandidate => candidate !== null)
    .sort((left, right) => SEVERITY_ORDER[right.alert.severity] - SEVERITY_ORDER[left.alert.severity]
      || right.alert.riskScore - left.alert.riskScore
      || Number(right.currentFailure) - Number(left.currentFailure)
      || right.gap - left.gap
      || left.station.id.localeCompare(right.station.id))
    .slice(0, policy.maximumAlerts)

  const actionableTasks = alertCandidates.filter((candidate): candidate is AlertCandidate & { condition: ActionableCondition } =>
    candidate.condition !== 'unavailable' && candidate.gap >= policy.minimumTransferBikes)
  const taskStationIds = new Set(actionableTasks.map(task => task.station.id))
  const usedStationIds = new Set<string>()
  const bikeSupply = new Map(orderedStations.map(station => [
    station.id,
    Math.max(0, Math.floor(station.availableBikes - safetyStockFor(station, policy))),
  ]))
  const dockSupply = new Map(orderedStations.map(station => [
    station.id,
    Math.max(0, Math.floor(station.availableDocks - safetyStockFor(station, policy))),
  ]))
  const dispatches: DispatchRecommendation[] = []

  for (const task of actionableTasks) {
    if (dispatches.length >= policy.maximumDispatches) break
    if (usedStationIds.has(task.station.id)) continue

    const operation = operationFor(task.condition)
    const candidate = findDispatchCandidate(
      task,
      orderedStations,
      taskStationIds,
      usedStationIds,
      bikeSupply,
      dockSupply,
      policy,
    )
    if (!candidate) {
      const resource = operation === 'deliver_bikes' ? '可供車輛' : '可用車位'
      task.alert = {
        ...task.alert,
        reasons: [
          ...task.alert.reasons,
          `未找到 ${policy.maximumDistanceKm} 公里內、保留安全庫存後仍有${resource}的可行站點。`,
        ],
      }
      continue
    }

    const sourceAvailableBikes = operation === 'deliver_bikes'
      ? candidate.available
      : Math.max(0, Math.floor(finiteNumber(task.station.availableBikes)))
    const destinationAvailableDocks = operation === 'deliver_bikes'
      ? Math.max(0, Math.floor(finiteNumber(task.station.availableDocks)))
      : candidate.available
    const bikeCount = Math.min(
      task.gap,
      candidate.available,
      policy.maximumTransferBikes,
      sourceAvailableBikes,
      destinationAvailableDocks,
    )
    if (bikeCount < policy.minimumTransferBikes) continue
    const candidateSafetyStock = safetyStockFor(candidate.station, policy)
    const fromStation = operation === 'deliver_bikes' ? candidate.station : task.station
    const toStation = operation === 'deliver_bikes' ? task.station : candidate.station

    if (operation === 'deliver_bikes') {
      bikeSupply.set(candidate.station.id, candidate.available - bikeCount)
    } else {
      dockSupply.set(candidate.station.id, candidate.available - bikeCount)
    }
    usedStationIds.add(task.station.id)
    usedStationIds.add(candidate.station.id)

    dispatches.push({
      id: dispatchId(observedAt, operation, policy.horizon, fromStation.id, toStation.id),
      alertId: task.alert.id,
      operation,
      fromStationId: fromStation.id,
      toStationId: toStation.id,
      bikeCount,
      distanceKm: rounded(candidate.distanceKm, 2),
      priorityScore: priorityScore(task, candidate.distanceKm),
      reasons: dispatchReasons(operation, task, candidate, bikeCount, candidateSafetyStock),
      status: 'proposed',
      requiresOperatorReview: true,
    })
  }

  dispatches.sort((left, right) => right.priorityScore - left.priorityScore
    || left.distanceKm - right.distanceKm
    || left.id.localeCompare(right.id))

  return {
    alerts: alertCandidates.map(candidate => candidate.alert),
    dispatches,
  }
}
