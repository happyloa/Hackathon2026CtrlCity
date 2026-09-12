import {
  displayStationName,
  type Alert,
  type CurrentState,
  type DispatchRecommendation,
  type Forecast,
  type HorizonKey,
  type StationRisk,
} from './ops.ts'
import {
  DEFAULT_LIVE_OPERATION_POLICY as SHARED_DEFAULT_LIVE_OPERATION_POLICY,
  alertDataQuality as sharedAlertDataQuality,
  refillAmountFor as sharedRefillAmountFor,
  safetyStockFor as sharedSafetyStockFor,
  scoreAlertPriority as sharedScoreAlertPriority,
} from './operational-policy.mjs'

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
}

type ActionableTask = AlertCandidate & { condition: ActionableCondition }

interface DispatchEdge extends DispatchCandidate {
  task: ActionableTask
  pairedTask: ActionableTask | null
  operation: DispatchOperation
  utility: number
}

export interface AlertPriorityInput {
  durationMinutes?: number | null
  riskScore: number
  currentFailure: boolean
  gap: number
  quality: number
}

export const DEFAULT_LIVE_OPERATION_POLICY: Readonly<LiveOperationPolicy> = SHARED_DEFAULT_LIVE_OPERATION_POLICY

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
  return sharedSafetyStockFor(station, options)
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

/**
 * Convert independent operational signals into additive points. The returned
 * parts are point contributions, so the UI can explain the total without
 * presenting the model risk as a calibrated probability.
 */
export function scoreAlertPriority(input: AlertPriorityInput): Pick<Alert, 'priorityScore' | 'scoreParts'> {
  return sharedScoreAlertPriority(input)
}

export function alertDataQuality(station: StationRisk, forecast: Forecast): number {
  return sharedAlertDataQuality(station, forecast)
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
        startedAt: new Date(Date.parse(observedAt) - (station.statusDurationMinutes ?? 0) * 60000).toISOString(),
        durationMinutes: station.statusDurationMinutes ?? 0,
        riskScore,
        priorityScore: 0,
        scoreParts: { forecast: 0, current: 0, gap: 0, quality: 0 },
        dispatchEligible: false,
        status: 'open',
        reasons: ['服務狀態異常，已排除預測與路線。'],
      },
    }
  }

  let condition: ActionableCondition | null = null
  let riskScore = 0
  let currentFailure = false

  if (station.currentState === 'empty_now') {
    condition = 'empty_now'
    riskScore = finiteNumber(forecast.emptyRisk)
    currentFailure = true
  } else if (station.currentState === 'full_now') {
    condition = 'full_now'
    riskScore = finiteNumber(forecast.fullRisk)
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
  const gap = sharedRefillAmountFor(station, inventory, policy)
  const emptyCondition = condition === 'empty_now' || condition === 'empty_forecast'
  const inventoryLabel = emptyCondition ? '可借車' : '可還位'
  const timingLabel = currentFailure ? '目前' : `${policy.horizon} 分鐘預測`
  const reason = currentFailure
    ? `${timingLabel}${inventoryLabel}已為 0，低於 ${safetyStock} 的安全庫存。`
    : gap > 0
      ? `${timingLabel}${inventoryLabel}為 ${Math.round(inventory)}，低於安全量 ${safetyStock}。`
      : `${timingLabel}${inventoryLabel}為 ${Math.round(inventory)}，風險已達提醒門檻。`
  const score = scoreAlertPriority({
    riskScore,
    currentFailure,
    gap,
    quality: alertDataQuality(station, forecast),
    durationMinutes: station.statusDurationMinutes,
  })

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
      startedAt: new Date(Date.parse(observedAt) - (currentFailure ? station.statusDurationMinutes ?? 0 : 0) * 60_000).toISOString(),
      durationMinutes: currentFailure ? station.statusDurationMinutes ?? 0 : 0,
      riskScore,
      ...score,
      dispatchEligible: gap >= policy.minimumTransferBikes,
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

function conditionIsEmpty(condition: ActionableCondition): boolean {
  return condition === 'empty_now' || condition === 'empty_forecast'
}

function conditionsAreComplementary(left: ActionableCondition, right: ActionableCondition): boolean {
  return conditionIsEmpty(left) !== conditionIsEmpty(right)
}

function taskComesFirst(left: ActionableTask, right: ActionableTask): boolean {
  return left.alert.priorityScore > right.alert.priorityScore
    || (left.alert.priorityScore === right.alert.priorityScore && left.station.id.localeCompare(right.station.id) < 0)
}

function candidateRisk(station: StationRisk, operation: DispatchOperation, horizon: HorizonKey): number {
  const forecast = station.forecast.horizons[horizon]
  return clamp(operation === 'deliver_bikes' ? forecast.emptyRisk : forecast.fullRisk, 0, 1)
}

function candidateCanSupport(
  station: StationRisk,
  operation: DispatchOperation,
  horizon: HorizonKey,
  pairedTask: ActionableTask | undefined,
): boolean {
  if (station.serviceStatus !== 'operational' || station.currentState === 'unavailable') return false
  if (pairedTask) {
    return operation === 'deliver_bikes'
      ? !conditionIsEmpty(pairedTask.condition)
      : conditionIsEmpty(pairedTask.condition)
  }
  if (station.currentState !== 'normal') return false
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
  taskByStationId: ReadonlyMap<string, ActionableTask>,
  policy: LiveOperationPolicy,
): DispatchEdge[] {
  const operation = operationFor(task.condition)
  const candidates: DispatchEdge[] = []

  for (const station of stations) {
    if (station.id === task.station.id) continue
    const pairedTask = taskByStationId.get(station.id)
    if (pairedTask && (!conditionsAreComplementary(task.condition, pairedTask.condition) || !taskComesFirst(task, pairedTask))) continue
    if (!candidateCanSupport(station, operation, policy.horizon, pairedTask)) continue

    const available = operation === 'deliver_bikes'
      ? Math.max(0, Math.floor(station.availableBikes - safetyStockFor(station, policy)))
      : Math.max(0, Math.floor(station.availableDocks - safetyStockFor(station, policy)))
    if (available < policy.minimumTransferBikes) continue

    const distanceKm = distanceKmBetween(station, task.station)
    if (distanceKm === null || distanceKm > policy.maximumDistanceKm) continue
    const competingRisk = candidateRisk(station, operation, policy.horizon)
    const fulfillmentRatio = task.gap > 0 ? Math.min(1, available / task.gap) : 0
    candidates.push({
      task,
      pairedTask: pairedTask || null,
      operation,
      station,
      distanceKm,
      available,
      competingRisk,
      utility: dispatchPriorityScore(task, distanceKm) * 100
        + fulfillmentRatio * 120
        + (pairedTask ? 250 : 0)
        - competingRisk * 10,
    })
  }

  return candidates
}

function dispatchPriorityScore(task: AlertCandidate, distanceKm: number): number {
  const distancePenalty = Math.min(15, Math.max(0, distanceKm) * 1.5)
  return rounded(clamp(task.alert.priorityScore - distancePenalty, 0, 100), 1)
}

function dispatchReasons(
  operation: DispatchOperation,
  task: AlertCandidate,
  candidate: DispatchEdge,
  bikeCount: number,
  policy: LiveOperationPolicy,
): string[] {
  const source = operation === 'deliver_bikes' ? candidate.station : task.station
  const destination = operation === 'deliver_bikes' ? task.station : candidate.station
  const sourceSafetyStock = safetyStockFor(source, policy)
  const destinationSafetyStock = safetyStockFor(destination, policy)
  const inventoryReason = `搬運後來源站仍保留至少 ${sourceSafetyStock} 輛可借車，目的站仍保留至少 ${destinationSafetyStock} 個可還位。`

  const pairedReason = candidate.pairedTask
    ? `此站對站搬運同時減輕「${displayStationName(task.station.name)}」與「${displayStationName(candidate.pairedTask.station.name)}」的相反庫存壓力。`
    : `供需配對同時考量優先分數、可搬運量與站點距離。`

  return [
    `建議將 ${bikeCount} 輛由「${displayStationName(source.name)}」移至「${displayStationName(destination.name)}」，處理「${displayStationName(task.station.name)}」的 ${task.alert.condition} 告警。`,
    inventoryReason,
    pairedReason,
    `兩站直線距離約 ${rounded(candidate.distanceKm, 1)} 公里；本平台未納入道路時間、車隊位置或班表。`,
  ]
}

/**
 * Produces a deterministic, side-effect-free live operations plan.
 *
 * Stable stations can support multiple same-direction dispatches. Complementary
 * full/empty risks can be paired directly, and every recommendation preserves
 * configured bike and dock safety stock at both endpoints.
 */
export function buildLiveOperations(
  stations: readonly StationRisk[],
  observedAt: string,
  options: Partial<LiveOperationPolicy> = {},
): LiveOperationPlan {
  if (!observedAt.trim()) throw new TypeError('observedAt must be a non-empty timestamp')
  const policy = normalizedPolicy(options)
  const orderedStations = [...stations].sort((left, right) => left.id.localeCompare(right.id))
  const allAlertCandidates = orderedStations
    .map(station => actionableAlert(station, observedAt, policy))
    .filter((candidate): candidate is AlertCandidate => candidate !== null)
  const inventoryAlertCandidates = allAlertCandidates
    .filter(candidate => candidate.condition !== 'unavailable')
    .sort((left, right) => right.alert.priorityScore - left.alert.priorityScore
      || SEVERITY_ORDER[right.alert.severity] - SEVERITY_ORDER[left.alert.severity]
      || right.alert.riskScore - left.alert.riskScore
      || Number(right.currentFailure) - Number(left.currentFailure)
      || right.gap - left.gap
      || left.station.id.localeCompare(right.station.id))
  const serviceAlertCandidates = allAlertCandidates
    .filter(candidate => candidate.condition === 'unavailable')
    .sort((left, right) => left.station.id.localeCompare(right.station.id))
  const alertCandidates = [...inventoryAlertCandidates, ...serviceAlertCandidates]

  const actionableTasks = inventoryAlertCandidates
    .filter((candidate): candidate is ActionableTask => candidate.alert.dispatchEligible
      && candidate.condition !== 'unavailable'
      && candidate.gap >= policy.minimumTransferBikes)
    .slice(0, policy.maximumAlerts)
  const taskByStationId = new Map(actionableTasks.map(task => [task.station.id, task]))
  const bikeSupply = new Map(orderedStations.map(station => [
    station.id,
    Math.max(0, Math.floor(station.availableBikes - safetyStockFor(station, policy))),
  ]))
  const dockSupply = new Map(orderedStations.map(station => [
    station.id,
    Math.max(0, Math.floor(station.availableDocks - safetyStockFor(station, policy))),
  ]))
  const remainingByAlertId = new Map(actionableTasks.map(task => [task.alert.id, task.gap]))
  const allocatedByAlertId = new Map<string, number>()
  const eligibleAlertIds = new Set<string>()
  const stationFlowRoles = new Map<string, 'source' | 'destination'>()
  const dispatches: DispatchRecommendation[] = []

  const edges = actionableTasks
    .flatMap(task => dispatchEdgesForTask(task, orderedStations, taskByStationId, policy))
    .sort((left, right) => right.utility - left.utility
      || right.task.alert.priorityScore - left.task.alert.priorityScore
      || left.distanceKm - right.distanceKm
      || left.task.station.id.localeCompare(right.task.station.id)
      || left.station.id.localeCompare(right.station.id))

  for (const edge of edges) {
    eligibleAlertIds.add(edge.task.alert.id)
    if (edge.pairedTask) eligibleAlertIds.add(edge.pairedTask.alert.id)
  }

  for (const edge of edges) {
    if (dispatches.length >= policy.maximumDispatches) break
    const { task, pairedTask, operation, station: candidate } = edge
    const remainingGap = remainingByAlertId.get(task.alert.id) ?? 0
    if (remainingGap < policy.minimumTransferBikes) continue
    const pairedRemainingGap = pairedTask
      ? remainingByAlertId.get(pairedTask.alert.id) ?? 0
      : Number.POSITIVE_INFINITY
    if (pairedRemainingGap < policy.minimumTransferBikes) continue

    const fromStation = operation === 'deliver_bikes' ? candidate : task.station
    const toStation = operation === 'deliver_bikes' ? task.station : candidate
    const sourceRole = stationFlowRoles.get(fromStation.id)
    const destinationRole = stationFlowRoles.get(toStation.id)
    if (sourceRole === 'destination' || destinationRole === 'source') continue

    const sourceAvailableBikes = bikeSupply.get(fromStation.id) ?? 0
    const destinationAvailableDocks = dockSupply.get(toStation.id) ?? 0
    const bikeCount = Math.min(
      remainingGap,
      pairedRemainingGap,
      policy.maximumTransferBikes,
      sourceAvailableBikes,
      destinationAvailableDocks,
    )
    if (bikeCount < policy.minimumTransferBikes) continue

    bikeSupply.set(fromStation.id, sourceAvailableBikes - bikeCount)
    dockSupply.set(toStation.id, destinationAvailableDocks - bikeCount)
    stationFlowRoles.set(fromStation.id, 'source')
    stationFlowRoles.set(toStation.id, 'destination')
    remainingByAlertId.set(task.alert.id, remainingGap - bikeCount)
    allocatedByAlertId.set(task.alert.id, (allocatedByAlertId.get(task.alert.id) ?? 0) + bikeCount)
    if (pairedTask) {
      remainingByAlertId.set(pairedTask.alert.id, pairedRemainingGap - bikeCount)
      allocatedByAlertId.set(pairedTask.alert.id, (allocatedByAlertId.get(pairedTask.alert.id) ?? 0) + bikeCount)
    }

    dispatches.push({
      id: dispatchId(observedAt, operation, policy.horizon, fromStation.id, toStation.id),
      alertId: task.alert.id,
      operation,
      fromStationId: fromStation.id,
      toStationId: toStation.id,
      bikeCount,
      distanceKm: rounded(edge.distanceKm, 2),
      priorityScore: dispatchPriorityScore(task, edge.distanceKm),
      reasons: dispatchReasons(operation, task, edge, bikeCount, policy),
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
        ? `已安排 ${allocated} 輛，剩餘 ${remainingGap} 輛沒有排入建議。`
        : '可用供給已優先留給風險較高或距離較近的站點。'
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

/** Prediction horizons for the dispatch route summary: "now" plus every forecast horizon. */
export type DispatchHorizon = 'now' | HorizonKey

const CUMULATIVE_HORIZON_STEPS: readonly HorizonKey[] = ['30', '60']

function forcedCurrentStateFor(condition: Alert['condition']): CurrentState | null {
  if (condition === 'empty_forecast') return 'empty_now'
  if (condition === 'full_forecast') return 'full_now'
  return null
}

/**
 * Widens `buildLiveOperations` into the three cumulative dispatch-route tabs
 * ("now" / "30" / "60") without changing that function's signature. Each step
 * re-runs the single-horizon planner from scratch (so route capacity is
 * always respected), but a station that already qualified at a shorter
 * horizon is pinned to its failing current-state before the next, longer
 * call -- otherwise a recovering forecast could silently drop it, breaking
 * the "60 always covers 30" guarantee.
 */
export function buildLiveOperationsForHorizon(
  stations: readonly StationRisk[],
  observedAt: string,
  horizon: DispatchHorizon,
  options: Partial<LiveOperationPolicy> = {},
): LiveOperationPlan {
  if (horizon === 'now') {
    const plan = buildLiveOperations(stations, observedAt, { ...options, horizon: '30' })
    const currentAlertIds = new Set(
      plan.alerts
        .filter(alert => alert.condition === 'empty_now' || alert.condition === 'full_now')
        .map(alert => alert.id),
    )
    return {
      alerts: plan.alerts.filter(alert => currentAlertIds.has(alert.id) || alert.condition === 'unavailable'),
      dispatches: plan.dispatches.filter(dispatch => dispatch.alertId !== null && currentAlertIds.has(dispatch.alertId)),
    }
  }

  let carriedStations = stations
  for (const step of CUMULATIVE_HORIZON_STEPS) {
    const plan = buildLiveOperations(carriedStations, observedAt, { ...options, horizon: step })
    if (step === horizon) return plan

    const forcedStateByStationId = new Map(plan.alerts.flatMap((alert) => {
      if (!alert.dispatchEligible) return []
      const forcedState = forcedCurrentStateFor(alert.condition)
      return forcedState ? [[alert.stationId, forcedState] as const] : []
    }))
    carriedStations = carriedStations.map(station => (
      station.currentState === 'normal' && forcedStateByStationId.has(station.id)
        ? { ...station, currentState: forcedStateByStationId.get(station.id)! }
        : station
    ))
  }

  return buildLiveOperations(carriedStations, observedAt, { ...options, horizon: '60' })
}
