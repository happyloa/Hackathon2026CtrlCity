import { distanceKmBetween } from './live-operations.ts'
import type { DispatchHorizon } from './live-operations.ts'
import { displayStationName, type StationRisk } from './ops.ts'
import type { DispatchRoutePlan, DispatchRouteStop, DispatchRouteStopAllocation } from './dispatch-route-planner.ts'

/** One user-placed stop: a station plus how many bikes to pick up / drop off there. */
export interface ManualRouteStopInput {
  id: string
  stationId: string
  pickupBikes: number
  dropoffBikes: number
}

/**
 * A fully user-authored route: not derived from `buildDispatchRoutePlans`,
 * edited and persisted independently. `scheduledAt` is a wall-clock "HH:mm"
 * (Asia/Taipei) for when the operator plans to run it -- it decides which
 * forecast horizon its predicted stop-by-stop inventory is drawn from, and
 * which horizons of the auto-generated planner it should suppress (see
 * `horizonBucketFor`/`applyManualRouteEffects`).
 */
export interface ManualRoute {
  id: string
  label: string
  vehicleCapacity: number
  scheduledAt: string
  stops: ManualRouteStopInput[]
  createdAt: string
  updatedAt: string
}

export interface ManualRouteStopComputed {
  sequence: number
  stopId: string
  stationId: string
  stationName: string
  district: string
  pickupBikes: number
  dropoffBikes: number
  vehicleLoadAfter: number
  distanceFromPreviousKm: number
  /** Station inventory this stop would leave behind, or null if the station can't be resolved. */
  predictedBikesAfter: number | null
  predictedDocksAfter: number | null
  issues: string[]
}

export interface ManualRoutePlan {
  id: string
  label: string
  scheduledAt: string
  /** Which auto-planner horizon bucket `scheduledAt` currently falls into. */
  horizon: DispatchHorizon
  vehicleCapacity: number
  stops: ManualRouteStopComputed[]
  totalTransferBikes: number
  totalDistanceKm: number
  peakVehicleLoad: number
  endingVehicleLoad: number
  feasible: boolean
  issues: string[]
}

function rounded(value: number, digits = 2): number {
  const scale = 10 ** digits
  return Math.round(value * scale) / scale
}

function taipeiParts(epochMs: number) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(epochMs))
  const get = (type: string) => Number(parts.find(part => part.type === type)?.value || 0)
  return { year: get('year'), month: get('month'), day: get('day'), hour: get('hour'), minute: get('minute') }
}

/** Formats an epoch as an `<input type="time">`-ready "HH:mm" in Asia/Taipei. */
export function taipeiTimeLabel(epochMs: number): string {
  const { hour, minute } = taipeiParts(epochMs)
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
}

/**
 * Minutes from `asOf` until a "HH:mm" wall-clock time, same Asia/Taipei
 * calendar day as `asOf`. Taipei has no DST, so the +08:00 offset is fixed.
 * A time already earlier today than `asOf` returns a non-positive number
 * (treated as due-now by `horizonBucketFor`) rather than rolling to tomorrow
 * -- this tool only reasons about the next couple of hours, same-day.
 */
export function minutesUntilScheduledTime(scheduledAt: string, asOf: string): number {
  const match = /^(\d{2}):(\d{2})$/.exec(scheduledAt)
  const asOfEpoch = Date.parse(asOf)
  if (!match || !Number.isFinite(asOfEpoch)) return 0
  const { year, month, day } = taipeiParts(asOfEpoch)
  const scheduledEpoch = Date.UTC(year, month - 1, day, Number(match[1]) - 8, Number(match[2]))
  return Math.round((scheduledEpoch - asOfEpoch) / 60_000)
}

/**
 * Buckets a schedule into the same three horizons the auto planner already
 * uses (`DispatchHorizon`): due now, closer to the 30-minute forecast, or
 * closer to the 60-minute one. 45 minutes is the midpoint between the two
 * forecast horizons this app has (there is no 45-minute forecast to switch
 * on directly).
 */
export function horizonBucketFor(minutesFromNow: number): DispatchHorizon {
  if (minutesFromNow <= 0) return 'now'
  if (minutesFromNow <= 45) return '30'
  return '60'
}

const HORIZON_ORDER: readonly DispatchHorizon[] = ['now', '30', '60']

function baselineInventory(station: StationRisk, horizon: DispatchHorizon): { bikes: number; docks: number } {
  if (horizon === 'now') return { bikes: station.availableBikes, docks: station.availableDocks }
  const forecast = station.forecast.horizons[horizon]
  if (!forecast || forecast.baselineStatus !== 'matched') return { bikes: station.availableBikes, docks: station.availableDocks }
  return { bikes: forecast.predictedBikes, docks: forecast.predictedDocks }
}

/**
 * Recomputes a manually-edited route from scratch every time it changes --
 * mirrors what `mergedStops()`/`peakLoad()` do for the auto-generated
 * heuristic in `dispatch-route-planner.ts`, but over user-placed stops
 * instead of dispatch-recommendation-backed actions, and against the
 * station inventory predicted for `horizon` (live for 'now', the matching
 * forecast horizon otherwise) rather than always the live snapshot. Never
 * mutates in place: an edit anywhere in the route, a change to its
 * scheduled time, or a live data refresh is reflected everywhere downstream.
 */
export function recomputeManualRoute(route: ManualRoute, stations: readonly StationRisk[], horizon: DispatchHorizon): ManualRoutePlan {
  const stationById = new Map(stations.map(station => [station.id, station]))
  const capacity = Math.max(1, Math.round(route.vehicleCapacity) || 1)
  let vehicleLoad = 0
  let peak = 0
  let totalDistance = 0
  let totalTransferBikes = 0
  let previousStation: StationRisk | null = null
  const routeIssues: string[] = []

  const stops: ManualRouteStopComputed[] = route.stops.map((input, index) => {
    const station = stationById.get(input.stationId) ?? null
    const pickupBikes = Math.max(0, Math.round(input.pickupBikes) || 0)
    const dropoffBikes = Math.max(0, Math.round(input.dropoffBikes) || 0)
    vehicleLoad += pickupBikes - dropoffBikes
    peak = Math.max(peak, vehicleLoad)
    totalTransferBikes += pickupBikes + dropoffBikes

    const baseline = station ? baselineInventory(station, horizon) : null
    const issues: string[] = []
    if (!station) issues.push('站點資料不存在或目前離線。')
    if (vehicleLoad < 0) issues.push('車上庫存為負，請調整取卸車順序或數量。')
    if (vehicleLoad > capacity) issues.push(`超過車輛容量 ${capacity} 台。`)
    if (baseline && pickupBikes > baseline.bikes) issues.push(`預估可借車僅 ${baseline.bikes} 台，取車量可能過高。`)
    if (baseline && dropoffBikes > baseline.docks) issues.push(`預估可還位僅 ${baseline.docks} 個，卸車量可能過高。`)

    const distanceFromPreviousKm = previousStation && station ? rounded(distanceKmBetween(previousStation, station) ?? 0) : 0
    totalDistance += distanceFromPreviousKm
    if (station) previousStation = station

    const predictedBikesAfter = baseline ? baseline.bikes - pickupBikes + dropoffBikes : null
    const predictedDocksAfter = baseline ? baseline.docks - dropoffBikes + pickupBikes : null

    routeIssues.push(...issues)
    return {
      sequence: index + 1,
      stopId: input.id,
      stationId: input.stationId,
      stationName: station ? displayStationName(station.name) : '（找不到站點）',
      district: station?.district ?? '',
      pickupBikes,
      dropoffBikes,
      vehicleLoadAfter: vehicleLoad,
      distanceFromPreviousKm,
      predictedBikesAfter,
      predictedDocksAfter,
      issues,
    }
  })

  if (route.stops.length && vehicleLoad !== 0) {
    routeIssues.push(`路線結束時車上還有 ${vehicleLoad} 台未卸下，尚未歸零。`)
  }

  return {
    id: route.id,
    label: route.label,
    scheduledAt: route.scheduledAt,
    horizon,
    vehicleCapacity: capacity,
    stops,
    totalTransferBikes,
    totalDistanceKm: rounded(totalDistance),
    peakVehicleLoad: peak,
    endingVehicleLoad: vehicleLoad,
    feasible: routeIssues.length === 0,
    issues: routeIssues,
  }
}

/**
 * Nets out every manual route scheduled at or before `activeHorizon` (in
 * now -> 30 -> 60 order) from the stations the auto planner sees, so it
 * doesn't re-suggest bikes an operator has already manually routed. A route
 * scheduled further out than `activeHorizon` hasn't happened yet from that
 * horizon's point of view, so it's left out.
 */
export function applyManualRouteEffects(
  stations: readonly StationRisk[],
  manualPlans: readonly ManualRoutePlan[],
  activeHorizon: DispatchHorizon,
): StationRisk[] {
  const activeIndex = HORIZON_ORDER.indexOf(activeHorizon)
  const netByStation = new Map<string, { bikes: number; docks: number }>()

  for (const plan of manualPlans) {
    if (HORIZON_ORDER.indexOf(plan.horizon) > activeIndex) continue
    for (const stop of plan.stops) {
      const net = netByStation.get(stop.stationId) ?? { bikes: 0, docks: 0 }
      net.bikes += stop.dropoffBikes - stop.pickupBikes
      net.docks += stop.pickupBikes - stop.dropoffBikes
      netByStation.set(stop.stationId, net)
    }
  }
  if (!netByStation.size) return stations as StationRisk[]

  return stations.map((station) => {
    const net = netByStation.get(station.id)
    if (!net) return station
    return {
      ...station,
      availableBikes: Math.max(0, Math.min(station.totalDocks, station.availableBikes + net.bikes)),
      availableDocks: Math.max(0, Math.min(station.totalDocks, station.availableDocks + net.docks)),
    }
  })
}

/**
 * Adapts a `ManualRoutePlan` into the same shape `buildDispatchRoutePlans`
 * produces, so the existing read-only route comparison/flow/map components
 * can render a manual route without any changes of their own. `allocations`/
 * `planningMethod`/`distanceBasis` are placeholders nothing currently reads
 * back out -- they exist only to satisfy `DispatchRoutePlan`'s shape.
 */
export function toDispatchRoutePlanShape(plan: ManualRoutePlan): DispatchRoutePlan & {
  isManual: true
  manualRouteId: string
  label: string
  scheduledAt: string
  horizon: DispatchHorizon
} {
  const stops: DispatchRouteStop[] = plan.stops.map((stop) => {
    const action = stop.pickupBikes > 0 && stop.dropoffBikes > 0 ? 'mixed' as const : stop.dropoffBikes > 0 ? 'dropoff' as const : 'pickup' as const
    const allocation: DispatchRouteStopAllocation = {
      dispatchId: `manual:${plan.id}:${stop.stopId}`,
      operation: stop.pickupBikes >= stop.dropoffBikes ? 'deliver_bikes' : 'remove_bikes',
      action: action === 'mixed' ? 'pickup' : action,
      bikeCount: Math.max(stop.pickupBikes, stop.dropoffBikes),
    }
    return {
      sequence: stop.sequence,
      stationId: stop.stationId,
      stationName: stop.stationName,
      district: stop.district,
      action,
      pickupBikes: stop.pickupBikes,
      dropoffBikes: stop.dropoffBikes,
      vehicleLoadAfter: stop.vehicleLoadAfter,
      distanceFromPreviousKm: stop.distanceFromPreviousKm,
      allocations: [allocation],
    }
  })

  return {
    id: plan.id,
    dispatchIds: [],
    stops,
    taskCount: stops.length,
    totalTransferBikes: plan.totalTransferBikes,
    totalDistanceKm: plan.totalDistanceKm,
    peakVehicleLoad: plan.peakVehicleLoad,
    vehicleCapacity: plan.vehicleCapacity,
    highestPriorityScore: 0,
    averagePriorityScore: 0,
    planningMethod: 'manual_user_authored',
    distanceBasis: 'station_straight_line',
    reasons: plan.feasible ? ['使用者手動建立的調度路線，尚未經過模型排序。'] : plan.issues,
    isManual: true,
    manualRouteId: plan.id,
    label: plan.label,
    scheduledAt: plan.scheduledAt,
    horizon: plan.horizon,
  }
}
