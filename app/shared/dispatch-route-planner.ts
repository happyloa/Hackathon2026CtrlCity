import { distanceKmBetween, safetyStockFor } from './live-operations.ts'
import { displayStationName, type DispatchRecommendation, type StationRisk } from './ops.ts'

export interface DispatchRoutePlanningPolicy {
  vehicleCapacity: number
  maximumTasksPerRoute: number
  maximumStopsPerRoute: number
  maximumRouteDistanceKm: number
  maximumAdjacentTaskDistanceKm: number
  priorityOrderTolerance: number
  safetyStockRatio: number
  minimumSafetyStock: number
}

export type DispatchRouteStopAction = 'pickup' | 'dropoff' | 'mixed'

export interface DispatchRouteStopAllocation {
  dispatchId: string
  operation: DispatchRecommendation['operation']
  action: Exclude<DispatchRouteStopAction, 'mixed'>
  bikeCount: number
}

export interface DispatchRouteStop {
  sequence: number
  stationId: string
  stationName: string
  district: string
  action: DispatchRouteStopAction
  pickupBikes: number
  dropoffBikes: number
  vehicleLoadAfter: number
  distanceFromPreviousKm: number
  allocations: DispatchRouteStopAllocation[]
}

export interface DispatchRoutePlan {
  id: string
  dispatchIds: string[]
  stops: DispatchRouteStop[]
  taskCount: number
  totalTransferBikes: number
  totalDistanceKm: number
  peakVehicleLoad: number
  vehicleCapacity: number
  highestPriorityScore: number
  averagePriorityScore: number
  planningMethod: 'priority_adjacent_insertion_heuristic'
  distanceBasis: 'station_straight_line'
  reasons: string[]
}

export type UnplannedDispatchCode =
  | 'duplicate_dispatch'
  | 'invalid_quantity'
  | 'vehicle_capacity_exceeded'
  | 'station_not_found'
  | 'station_unavailable'
  | 'invalid_route'
  | 'missing_coordinates'
  | 'route_distance_exceeded'
  | 'source_safety_stock'
  | 'destination_safety_stock'

export interface UnplannedDispatch {
  dispatchId: string
  code: UnplannedDispatchCode
  reason: string
}

export interface DispatchRoutePlanningResult {
  routes: DispatchRoutePlan[]
  unplannedDispatches: UnplannedDispatch[]
}

interface PlanningTask {
  dispatch: DispatchRecommendation
  from: StationRisk
  to: StationRisk
  directDistanceKm: number
}

interface RouteAction {
  task: PlanningTask
  station: StationRisk
  action: 'pickup' | 'dropoff'
}

interface RouteInsertion {
  actions: RouteAction[]
  cost: number
  distanceKm: number
}

export const DEFAULT_DISPATCH_ROUTE_POLICY: Readonly<DispatchRoutePlanningPolicy> = Object.freeze({
  vehicleCapacity: 14,
  maximumTasksPerRoute: 4,
  maximumStopsPerRoute: 8,
  maximumRouteDistanceKm: 20,
  maximumAdjacentTaskDistanceKm: 2.5,
  priorityOrderTolerance: 8,
  safetyStockRatio: 0.15,
  minimumSafetyStock: 2,
})

function finite(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback
}

function rounded(value: number, digits = 2): number {
  const scale = 10 ** digits
  return Math.round(value * scale) / scale
}

function normalizedPolicy(options: Partial<DispatchRoutePlanningPolicy>): DispatchRoutePlanningPolicy {
  return {
    vehicleCapacity: Math.max(1, Math.round(finite(
      options.vehicleCapacity ?? DEFAULT_DISPATCH_ROUTE_POLICY.vehicleCapacity,
      DEFAULT_DISPATCH_ROUTE_POLICY.vehicleCapacity,
    ))),
    maximumTasksPerRoute: Math.max(1, Math.round(finite(
      options.maximumTasksPerRoute ?? DEFAULT_DISPATCH_ROUTE_POLICY.maximumTasksPerRoute,
      DEFAULT_DISPATCH_ROUTE_POLICY.maximumTasksPerRoute,
    ))),
    maximumStopsPerRoute: Math.max(2, Math.round(finite(
      options.maximumStopsPerRoute ?? DEFAULT_DISPATCH_ROUTE_POLICY.maximumStopsPerRoute,
      DEFAULT_DISPATCH_ROUTE_POLICY.maximumStopsPerRoute,
    ))),
    maximumRouteDistanceKm: Math.max(0.1, finite(
      options.maximumRouteDistanceKm ?? DEFAULT_DISPATCH_ROUTE_POLICY.maximumRouteDistanceKm,
      DEFAULT_DISPATCH_ROUTE_POLICY.maximumRouteDistanceKm,
    )),
    maximumAdjacentTaskDistanceKm: Math.max(0, finite(
      options.maximumAdjacentTaskDistanceKm ?? DEFAULT_DISPATCH_ROUTE_POLICY.maximumAdjacentTaskDistanceKm,
      DEFAULT_DISPATCH_ROUTE_POLICY.maximumAdjacentTaskDistanceKm,
    )),
    priorityOrderTolerance: Math.max(0, finite(
      options.priorityOrderTolerance ?? DEFAULT_DISPATCH_ROUTE_POLICY.priorityOrderTolerance,
      DEFAULT_DISPATCH_ROUTE_POLICY.priorityOrderTolerance,
    )),
    safetyStockRatio: Math.min(0.5, Math.max(0, finite(
      options.safetyStockRatio ?? DEFAULT_DISPATCH_ROUTE_POLICY.safetyStockRatio,
      DEFAULT_DISPATCH_ROUTE_POLICY.safetyStockRatio,
    ))),
    minimumSafetyStock: Math.max(0, Math.round(finite(
      options.minimumSafetyStock ?? DEFAULT_DISPATCH_ROUTE_POLICY.minimumSafetyStock,
      DEFAULT_DISPATCH_ROUTE_POLICY.minimumSafetyStock,
    ))),
  }
}

function compareTasks(left: PlanningTask, right: PlanningTask): number {
  return right.dispatch.priorityScore - left.dispatch.priorityScore
    || right.dispatch.bikeCount - left.dispatch.bikeCount
    || left.directDistanceKm - right.directDistanceKm
    || left.dispatch.id.localeCompare(right.dispatch.id)
}

function routeDistance(actions: readonly RouteAction[]): number {
  let total = 0
  for (let index = 1; index < actions.length; index += 1) {
    total += distanceKmBetween(actions[index - 1]!.station, actions[index]!.station) ?? 0
  }
  return total
}

function peakLoad(actions: readonly RouteAction[], vehicleCapacity: number): number | null {
  let load = 0
  let peak = 0
  for (const action of actions) {
    load += action.action === 'pickup' ? action.task.dispatch.bikeCount : -action.task.dispatch.bikeCount
    if (load < 0 || load > vehicleCapacity) return null
    peak = Math.max(peak, load)
  }
  return load === 0 ? peak : null
}

function stopCount(actions: readonly RouteAction[]): number {
  return actions.reduce((total, action, index) => (
    index === 0 || action.station.id !== actions[index - 1]!.station.id ? total + 1 : total
  ), 0)
}

function isServiceAction(action: RouteAction): boolean {
  return action.task.dispatch.operation === 'deliver_bikes'
    ? action.action === 'dropoff'
    : action.action === 'pickup'
}

function priorityOrderIsValid(actions: readonly RouteAction[], tolerance: number): boolean {
  const serviced = actions
    .filter(isServiceAction)
    .map(action => action.task.dispatch.priorityScore)

  return serviced.every((priority, index) => serviced
    .slice(index + 1)
    .every(laterPriority => laterPriority <= priority + tolerance))
}

function serviceDistanceCost(actions: readonly RouteAction[]): number {
  let distance = 0
  let cost = 0
  for (let index = 0; index < actions.length; index += 1) {
    if (index > 0) distance += distanceKmBetween(actions[index - 1]!.station, actions[index]!.station) ?? 0
    const action = actions[index]!
    if (isServiceAction(action)) {
      cost += distance * (1 + Math.max(0, action.task.dispatch.priorityScore) / 100)
    }
  }
  return cost
}

function taskIsAdjacent(
  task: PlanningTask,
  actions: readonly RouteAction[],
  maximumDistanceKm: number,
): boolean {
  return actions.some(action => {
    const fromDistance = distanceKmBetween(task.from, action.station)
    const toDistance = distanceKmBetween(task.to, action.station)
    return (fromDistance !== null && fromDistance <= maximumDistanceKm)
      || (toDistance !== null && toDistance <= maximumDistanceKm)
  })
}

function insertedAt(actions: readonly RouteAction[], index: number, action: RouteAction): RouteAction[] {
  return [...actions.slice(0, index), action, ...actions.slice(index)]
}

function bestInsertion(
  route: readonly RouteAction[],
  task: PlanningTask,
  policy: DispatchRoutePlanningPolicy,
): RouteInsertion | null {
  if (!taskIsAdjacent(task, route, policy.maximumAdjacentTaskDistanceKm)) return null
  const previousDistance = routeDistance(route)
  const previousServiceCost = serviceDistanceCost(route)
  let best: RouteInsertion | null = null

  // Keep the highest-priority seed pickup as the first stop of each trip.
  for (let pickupIndex = 1; pickupIndex <= route.length; pickupIndex += 1) {
    const withPickup = insertedAt(route, pickupIndex, { task, station: task.from, action: 'pickup' })
    for (let dropoffIndex = pickupIndex + 1; dropoffIndex <= withPickup.length; dropoffIndex += 1) {
      const candidate = insertedAt(withPickup, dropoffIndex, { task, station: task.to, action: 'dropoff' })
      if (stopCount(candidate) > policy.maximumStopsPerRoute) continue
      if (peakLoad(candidate, policy.vehicleCapacity) === null) continue
      if (!priorityOrderIsValid(candidate, policy.priorityOrderTolerance)) continue

      const distanceKm = routeDistance(candidate)
      if (distanceKm > policy.maximumRouteDistanceKm) continue
      const addedDistance = distanceKm - previousDistance
      const addedServiceCost = serviceDistanceCost(candidate) - previousServiceCost
      const urgencyPenalty = Math.max(0, 100 - task.dispatch.priorityScore) * 0.015
      const cost = addedDistance + Math.max(0, addedServiceCost) * 0.05 + urgencyPenalty

      if (!best || cost < best.cost
        || (cost === best.cost && distanceKm < best.distanceKm)) {
        best = { actions: candidate, cost, distanceKm }
      }
    }
  }

  return best
}

function mergedStops(actions: readonly RouteAction[]): DispatchRouteStop[] {
  const stops: DispatchRouteStop[] = []
  let vehicleLoad = 0
  let previousStation: StationRisk | null = null

  for (const action of actions) {
    const amount = action.task.dispatch.bikeCount
    vehicleLoad += action.action === 'pickup' ? amount : -amount
    const previous = stops.at(-1)
    const allocation: DispatchRouteStopAllocation = {
      dispatchId: action.task.dispatch.id,
      operation: action.task.dispatch.operation,
      action: action.action,
      bikeCount: amount,
    }

    if (previous?.stationId === action.station.id) {
      previous.pickupBikes += action.action === 'pickup' ? amount : 0
      previous.dropoffBikes += action.action === 'dropoff' ? amount : 0
      previous.vehicleLoadAfter = vehicleLoad
      previous.allocations.push(allocation)
      previous.action = previous.pickupBikes > 0 && previous.dropoffBikes > 0
        ? 'mixed'
        : previous.pickupBikes > 0 ? 'pickup' : 'dropoff'
      continue
    }

    const distanceFromPreviousKm = previousStation
      ? distanceKmBetween(previousStation, action.station) ?? 0
      : 0
    stops.push({
      sequence: stops.length + 1,
      stationId: action.station.id,
      stationName: displayStationName(action.station.name),
      district: action.station.district,
      action: action.action,
      pickupBikes: action.action === 'pickup' ? amount : 0,
      dropoffBikes: action.action === 'dropoff' ? amount : 0,
      vehicleLoadAfter: vehicleLoad,
      distanceFromPreviousKm: rounded(distanceFromPreviousKm),
      allocations: [allocation],
    })
    previousStation = action.station
  }

  return stops
}

function makeRoutePlan(
  actions: RouteAction[],
  index: number,
  policy: DispatchRoutePlanningPolicy,
): DispatchRoutePlan {
  const tasks = [...new Map(actions.map(action => [action.task.dispatch.id, action.task])).values()]
  const dispatchIds = actions
    .filter(action => action.action === 'dropoff')
    .map(action => action.task.dispatch.id)
  const priorities = tasks.map(task => task.dispatch.priorityScore)
  const highestPriorityScore = Math.max(...priorities)
  const totalDistanceKm = rounded(routeDistance(actions))
  const routePeakLoad = peakLoad(actions, policy.vehicleCapacity) ?? 0
  const stops = mergedStops(actions)

  return {
    id: `dispatch-route:${index + 1}:${encodeURIComponent(dispatchIds[0] ?? 'empty')}`,
    dispatchIds,
    stops,
    taskCount: tasks.length,
    totalTransferBikes: tasks.reduce((total, task) => total + task.dispatch.bikeCount, 0),
    totalDistanceKm,
    peakVehicleLoad: routePeakLoad,
    vehicleCapacity: policy.vehicleCapacity,
    highestPriorityScore: rounded(highestPriorityScore, 1),
    averagePriorityScore: rounded(priorities.reduce((total, priority) => total + priority, 0) / priorities.length, 1),
    planningMethod: 'priority_adjacent_insertion_heuristic',
    distanceBasis: 'station_straight_line',
    reasons: [
      `啟發式建議路線先處理優先分數 ${Math.round(highestPriorityScore)} 的任務，再合併 ${policy.maximumAdjacentTaskDistanceKm} 公里內的相鄰需求。`,
      `本趟 ${tasks.length} 筆任務共搬運 ${tasks.reduce((total, task) => total + task.dispatch.bikeCount, 0)} 台，尖峰載量 ${routePeakLoad}/${policy.vehicleCapacity} 台。`,
      `已保留來源可借車與目的可還位安全庫存；${totalDistanceKm} 公里為站點座標直線距離，不含調度場往返。`,
    ],
  }
}

function unplanned(
  dispatch: DispatchRecommendation,
  code: UnplannedDispatchCode,
  reason: string,
): UnplannedDispatch {
  return { dispatchId: dispatch.id, code, reason }
}

function feasibleTasks(
  dispatches: readonly DispatchRecommendation[],
  stations: readonly StationRisk[],
  policy: DispatchRoutePlanningPolicy,
): { tasks: PlanningTask[]; rejected: UnplannedDispatch[] } {
  const stationById = new Map(stations.map(station => [station.id, station]))
  const reservedPickups = new Map<string, number>()
  const reservedDropoffs = new Map<string, number>()
  const seenDispatchIds = new Set<string>()
  const tasks: PlanningTask[] = []
  const rejected: UnplannedDispatch[] = []
  const ordered = [...dispatches].sort((left, right) => right.priorityScore - left.priorityScore
    || right.bikeCount - left.bikeCount
    || left.id.localeCompare(right.id))

  for (const dispatch of ordered) {
    if (seenDispatchIds.has(dispatch.id)) {
      rejected.push(unplanned(dispatch, 'duplicate_dispatch', '重複的調度建議不會重複排入路線。'))
      continue
    }
    seenDispatchIds.add(dispatch.id)
    if (!Number.isInteger(dispatch.bikeCount) || dispatch.bikeCount <= 0) {
      rejected.push(unplanned(dispatch, 'invalid_quantity', '搬運量必須是大於零的整數。'))
      continue
    }
    if (dispatch.bikeCount > policy.vehicleCapacity) {
      rejected.push(unplanned(dispatch, 'vehicle_capacity_exceeded', `搬運量超過單車容量 ${policy.vehicleCapacity} 台。`))
      continue
    }

    const from = stationById.get(dispatch.fromStationId)
    const to = stationById.get(dispatch.toStationId)
    if (!from || !to) {
      rejected.push(unplanned(dispatch, 'station_not_found', '來源站或目的站不在目前站點資料內。'))
      continue
    }
    if (from.id === to.id) {
      rejected.push(unplanned(dispatch, 'invalid_route', '來源站與目的站不可相同。'))
      continue
    }
    if (from.serviceStatus !== 'operational' || to.serviceStatus !== 'operational'
      || from.currentState === 'unavailable' || to.currentState === 'unavailable') {
      rejected.push(unplanned(dispatch, 'station_unavailable', '停用或服務異常站點不納入物流路線。'))
      continue
    }

    const directDistanceKm = distanceKmBetween(from, to)
    if (directDistanceKm === null) {
      rejected.push(unplanned(dispatch, 'missing_coordinates', '站點缺少有效座標，無法計算路線。'))
      continue
    }
    if (directDistanceKm > policy.maximumRouteDistanceKm) {
      rejected.push(unplanned(dispatch, 'route_distance_exceeded', `單一任務已超過每趟 ${policy.maximumRouteDistanceKm} 公里的上限。`))
      continue
    }

    const safetyOptions = {
      safetyStockRatio: policy.safetyStockRatio,
      minimumSafetyStock: policy.minimumSafetyStock,
    }
    const pickupReserved = reservedPickups.get(from.id) ?? 0
    const sourceSafetyStock = safetyStockFor(from, safetyOptions)
    if (from.availableBikes - pickupReserved - dispatch.bikeCount < sourceSafetyStock) {
      rejected.push(unplanned(dispatch, 'source_safety_stock', `來源站調出後無法保留 ${sourceSafetyStock} 台安全庫存。`))
      continue
    }
    const dropoffReserved = reservedDropoffs.get(to.id) ?? 0
    const destinationSafetyStock = safetyStockFor(to, safetyOptions)
    if (to.availableDocks - dropoffReserved - dispatch.bikeCount < destinationSafetyStock) {
      rejected.push(unplanned(dispatch, 'destination_safety_stock', `目的站調入後無法保留 ${destinationSafetyStock} 個安全空位。`))
      continue
    }

    reservedPickups.set(from.id, pickupReserved + dispatch.bikeCount)
    reservedDropoffs.set(to.id, dropoffReserved + dispatch.bikeCount)
    tasks.push({ dispatch, from, to, directDistanceKm })
  }

  return { tasks: tasks.sort(compareTasks), rejected }
}

/**
 * Turns independently feasible station-to-station recommendations into complete
 * pickup-and-dropoff trips. Every route starts and ends empty, preserves station
 * safety stock, respects vehicle capacity, and only combines adjacent tasks.
 */
export function buildDispatchRoutePlans(
  dispatches: readonly DispatchRecommendation[],
  stations: readonly StationRisk[],
  options: Partial<DispatchRoutePlanningPolicy> = {},
): DispatchRoutePlanningResult {
  const policy = normalizedPolicy(options)
  const { tasks, rejected } = feasibleTasks(dispatches, stations, policy)
  const remaining = [...tasks]
  const actionRoutes: RouteAction[][] = []

  while (remaining.length > 0) {
    const seed = remaining.shift()!
    let actions: RouteAction[] = [
      { task: seed, station: seed.from, action: 'pickup' },
      { task: seed, station: seed.to, action: 'dropoff' },
    ]
    let taskCount = 1

    while (taskCount < policy.maximumTasksPerRoute) {
      const insertions = remaining.flatMap((task, taskIndex) => {
        const insertion = bestInsertion(actions, task, policy)
        return insertion ? [{ task, taskIndex, insertion }] : []
      }).sort((left, right) => left.insertion.cost - right.insertion.cost
        || right.task.dispatch.priorityScore - left.task.dispatch.priorityScore
        || left.insertion.distanceKm - right.insertion.distanceKm
        || left.task.dispatch.id.localeCompare(right.task.dispatch.id))

      const selected = insertions[0]
      if (!selected) break
      actions = selected.insertion.actions
      remaining.splice(selected.taskIndex, 1)
      taskCount += 1
    }

    actionRoutes.push(actions)
  }

  return {
    routes: actionRoutes.map((actions, index) => makeRoutePlan(actions, index, policy)),
    unplannedDispatches: rejected.sort((left, right) => left.dispatchId.localeCompare(right.dispatchId)),
  }
}
