import {
  displayStationName,
  type Alert,
  type DispatchRecommendation,
  type Forecast,
  type HorizonKey,
  type StationRisk,
} from './ops.ts'

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

type ActionableTask = AlertCandidate & { condition: ActionableCondition }

interface DispatchEdge extends DispatchCandidate {
  task: ActionableTask
  operation: DispatchOperation
  utility: number
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
      ? `${timingLabel}${inventoryLabel}為 ${Math.round(inventory)}，低於 ${safetyStock} 的安全庫存；風險分數為 ${Math.round(riskScore * 100)}／100。`
      : `${timingLabel}${inventoryLabel}為 ${Math.round(inventory)}；風險分數 ${Math.round(riskScore * 100)}／100 已達告警門檻，但預測庫存尚未低於安全庫存。`

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
  if (forecast.baselineStatus !== 'matched') return false
  return candidateRisk(station, operation, horizon) < alertThreshold(forecast)
}

/**
 * Build feasible edges before allocating vehicles. This lets urgent tasks
 * compete for the same stable station while keeping the outcome deterministic.
 */
function dispatchEdgesForTask(
  task: ActionableTask,
  stations: readonly StationRisk[],
  taskStationIds: Set<string>,
  policy: LiveOperationPolicy,
): DispatchEdge[] {
  const operation = operationFor(task.condition)
  const candidates: DispatchEdge[] = []

  for (const station of stations) {
    if (station.id === task.station.id || taskStationIds.has(station.id)) continue
    if (!candidateIsStable(station, operation, policy.horizon)) continue

    const available = operation === 'deliver_bikes'
      ? Math.max(0, Math.floor(station.availableBikes - safetyStockFor(station, policy)))
      : Math.max(0, Math.floor(station.availableDocks - safetyStockFor(station, policy)))
    if (available < policy.minimumTransferBikes) continue

    const distanceKm = distanceKmBetween(station, task.station)
    if (distanceKm === null || distanceKm > policy.maximumDistanceKm) continue
    const competingRisk = candidateRisk(station, operation, policy.horizon)
    const score = distanceKm + competingRisk * 3
    candidates.push({
      task,
      operation,
      station,
      distanceKm,
      available,
      competingRisk,
      score,
      utility: priorityScore(task, distanceKm) * 100 - score * 10,
    })
  }

  return candidates
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
    `建議將 ${bikeCount} 輛由「${displayStationName(source.name)}」移至「${displayStationName(destination.name)}」，處理「${displayStationName(task.station.name)}」的 ${task.alert.condition} 告警。`,
    inventoryReason,
    `兩站直線距離約 ${rounded(candidate.distanceKm, 1)} 公里；執行前仍需人工確認道路、載運與現場狀態。`,
  ]
}

/**
 * Produces a deterministic, side-effect-free live operations plan.
 *
 * Stable stations can support multiple same-direction dispatches in a plan.
 * Urgent stations are never reused as supply candidates, and every recommendation
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

  const actionableTasks = alertCandidates.filter((candidate): candidate is ActionableTask =>
    candidate.condition !== 'unavailable' && candidate.gap >= policy.minimumTransferBikes)
  const taskStationIds = new Set(actionableTasks.map(task => task.station.id))
  const bikeSupply = new Map(orderedStations.map(station => [
    station.id,
    Math.max(0, Math.floor(station.availableBikes - safetyStockFor(station, policy))),
  ]))
  const dockSupply = new Map(orderedStations.map(station => [
    station.id,
    Math.max(0, Math.floor(station.availableDocks - safetyStockFor(station, policy))),
  ]))
  const targetBikeSupply = new Map(actionableTasks.map(task => [
    task.station.id,
    Math.max(0, Math.floor(finiteNumber(task.station.availableBikes))),
  ]))
  const targetDockCapacity = new Map(actionableTasks.map(task => [
    task.station.id,
    Math.max(0, Math.floor(finiteNumber(task.station.availableDocks))),
  ]))
  const remainingByAlertId = new Map(actionableTasks.map(task => [task.alert.id, task.gap]))
  const allocatedByAlertId = new Map<string, number>()
  const eligibleAlertIds = new Set<string>()
  const stationRoles = new Map<string, DispatchOperation>()
  const dispatches: DispatchRecommendation[] = []

  const edges = actionableTasks
    .flatMap(task => dispatchEdgesForTask(task, orderedStations, taskStationIds, policy))
    .sort((left, right) => right.utility - left.utility
      || right.task.alert.riskScore - left.task.alert.riskScore
      || left.distanceKm - right.distanceKm
      || left.task.station.id.localeCompare(right.task.station.id)
      || left.station.id.localeCompare(right.station.id))

  for (const edge of edges) {
    if (dispatches.length >= policy.maximumDispatches) break
    const { task, operation, station: candidate } = edge
    eligibleAlertIds.add(task.alert.id)

    const remainingGap = remainingByAlertId.get(task.alert.id) ?? 0
    if (remainingGap < policy.minimumTransferBikes) continue
    const assignedRole = stationRoles.get(candidate.id)
    if (assignedRole && assignedRole !== operation) continue

    const sourceAvailableBikes = operation === 'deliver_bikes'
      ? bikeSupply.get(candidate.id) ?? 0
      : targetBikeSupply.get(task.station.id) ?? 0
    const destinationAvailableDocks = operation === 'deliver_bikes'
      ? targetDockCapacity.get(task.station.id) ?? 0
      : dockSupply.get(candidate.id) ?? 0
    const bikeCount = Math.min(
      remainingGap,
      policy.maximumTransferBikes,
      sourceAvailableBikes,
      destinationAvailableDocks,
    )
    if (bikeCount < policy.minimumTransferBikes) continue
    const candidateSafetyStock = safetyStockFor(candidate, policy)
    const fromStation = operation === 'deliver_bikes' ? candidate : task.station
    const toStation = operation === 'deliver_bikes' ? task.station : candidate

    if (operation === 'deliver_bikes') {
      bikeSupply.set(candidate.id, sourceAvailableBikes - bikeCount)
      targetDockCapacity.set(task.station.id, destinationAvailableDocks - bikeCount)
    } else {
      targetBikeSupply.set(task.station.id, sourceAvailableBikes - bikeCount)
      dockSupply.set(candidate.id, destinationAvailableDocks - bikeCount)
    }
    stationRoles.set(candidate.id, operation)
    remainingByAlertId.set(task.alert.id, remainingGap - bikeCount)
    allocatedByAlertId.set(task.alert.id, (allocatedByAlertId.get(task.alert.id) ?? 0) + bikeCount)

    dispatches.push({
      id: dispatchId(observedAt, operation, policy.horizon, fromStation.id, toStation.id),
      alertId: task.alert.id,
      operation,
      fromStationId: fromStation.id,
      toStationId: toStation.id,
      bikeCount,
      distanceKm: rounded(edge.distanceKm, 2),
      priorityScore: priorityScore(task, edge.distanceKm),
      reasons: dispatchReasons(operation, task, edge, bikeCount, candidateSafetyStock),
      status: 'proposed',
      requiresOperatorReview: true,
    })
  }

  for (const task of actionableTasks) {
    const remainingGap = remainingByAlertId.get(task.alert.id) ?? 0
    if (remainingGap <= 0) continue

    const operation = operationFor(task.condition)
    const resource = operation === 'deliver_bikes' ? '可供車輛' : '可用車位'
    const allocated = allocatedByAlertId.get(task.alert.id) ?? 0
    const allocationReason = !eligibleAlertIds.has(task.alert.id)
      ? `未找到 ${policy.maximumDistanceKm} 公里內、保留安全庫存後仍有${resource}的可行站點。`
      : allocated > 0
        ? `已優先分配 ${allocated} 輛，剩餘 ${remainingGap} 輛缺口需由值班人員覆核。`
        : '可用供給已優先配置給風險較高或距離較短的任務，請人工覆核。'
    task.alert = {
      ...task.alert,
      reasons: [...task.alert.reasons, allocationReason],
    }
  }

  dispatches.sort((left, right) => right.priorityScore - left.priorityScore
    || left.distanceKm - right.distanceKm
    || left.id.localeCompare(right.id))

  return {
    alerts: alertCandidates.map(candidate => candidate.alert),
    dispatches,
  }
}
