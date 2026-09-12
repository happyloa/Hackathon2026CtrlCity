import type { DemandEvent } from './demand-events.mjs'
import { upcomingDemandSurgeImpacts, type DemandSurgeImpact } from './demand-surge-impact.ts'
import { distanceKmBetween, safetyStockFor } from './live-operations.ts'
import { DEFAULT_DISPATCH_ROUTE_POLICY } from './parameters.mjs'
import { displayStationName, type Alert, type DispatchRecommendation, type HorizonKey, type StationRisk } from './ops.ts'

export interface EventDrivenOperations {
  alerts: Alert[]
  dispatches: DispatchRecommendation[]
}

interface EventDrivenOptions {
  vehicleCapacity?: number
  safetyStockRatio?: number
  minimumSafetyStock?: number
}

function finite(value: number | null | undefined, fallback = 0): number {
  return Number.isFinite(value) ? (value as number) : fallback
}

function rounded(value: number, digits = 2): number {
  const scale = 10 ** digits
  return Math.round(value * scale) / scale
}

/** A forecast-30 route also needs to see 30-minute-tier impacts; a 60-minute route needs both tiers, matching the "60 always covers 30" convention used elsewhere. */
function impactAppliesToHorizon(impact: DemandSurgeImpact, horizon: HorizonKey): boolean {
  return horizon === '30' ? impact.tier === '30min' : true
}

/**
 * Splits a needed amount across neighbours, richest surplus first, capped at
 * one vehicle load per neighbour -- the same per-leg cap the route planner
 * itself enforces, so these candidates don't get silently rejected there.
 */
function allocateAcrossNeighbours(
  neededAmount: number,
  neighbours: readonly { id: string; surplus: number }[],
  vehicleCapacity: number,
): { neighbourId: string; amount: number }[] {
  const allocations: { neighbourId: string; amount: number }[] = []
  let remaining = neededAmount
  for (const neighbour of [...neighbours].sort((left, right) => right.surplus - left.surplus || left.id.localeCompare(right.id))) {
    if (remaining <= 0) break
    const amount = Math.max(0, Math.min(remaining, Math.floor(neighbour.surplus), vehicleCapacity))
    if (amount <= 0) continue
    allocations.push({ neighbourId: neighbour.id, amount })
    remaining -= amount
  }
  return allocations
}

/**
 * Turns demand-surge impacts (see demand-surge-impact.ts) into real Alert and
 * DispatchRecommendation candidates in the same shape `buildLiveOperations`
 * produces, so a caller can merge them into a horizon's alerts/dispatches
 * before handing everything to `buildDispatchRoutePlans` -- an anticipated
 * event then competes for route space exactly like a live shortage does.
 * `buildDispatchRoutePlans`'s own feasibility pass (safety stock, vehicle
 * capacity, distance) still has the final word on what actually ships.
 */
export function eventDrivenOperations(
  events: readonly DemandEvent[],
  stations: readonly StationRisk[],
  observedAt: string,
  nowEpoch: number,
  horizon: HorizonKey,
  options: EventDrivenOptions = {},
): EventDrivenOperations {
  const vehicleCapacity = Math.max(1, Math.round(finite(options.vehicleCapacity, DEFAULT_DISPATCH_ROUTE_POLICY.vehicleCapacity)))
  const stationById = new Map(stations.map(station => [station.id, station]))
  const impacts = upcomingDemandSurgeImpacts(events, stations, nowEpoch, options)
    .filter(impact => impactAppliesToHorizon(impact, horizon))

  const alerts: Alert[] = []
  const dispatches: DispatchRecommendation[] = []

  for (const impact of impacts) {
    const station = stationById.get(impact.stationId)
    if (!station) continue
    const borrow = impact.effect === 'borrow_surge'

    const neighbourSurplus = impact.neighbourStationIds.map((id) => {
      const neighbour = stationById.get(id)
      const headroom = !neighbour
        ? 0
        : borrow
          ? finite(neighbour.availableBikes) - safetyStockFor(neighbour, options)
          : finite(neighbour.availableDocks) - safetyStockFor(neighbour, options)
      return { id, surplus: Math.max(0, headroom) }
    })
    const allocations = allocateAcrossNeighbours(impact.estimatedDemand, neighbourSurplus, vehicleCapacity)
    const allocated = allocations.reduce((sum, item) => sum + item.amount, 0)
    const remainingGap = Math.max(0, impact.estimatedDemand - allocated)

    const alertId = `event-alert:${impact.eventId}:${impact.phaseIndex}:${impact.stationId}`
    const severity: Alert['severity'] = remainingGap > 0 ? 'critical' : impact.tier === '30min' ? 'high' : 'medium'
    const riskScore = impact.tier === '30min' ? 0.75 : 0.55
    const timeLabel = impact.tier === '30min' ? '30 分鐘內' : '60 分鐘內'
    const reasons = [
      `活動「${impact.eventName}」${impact.phaseLabel}預計 ${timeLabel}開始，「${displayStationName(station.name)}」預估${borrow ? '借車' : '還車'}量約 ${impact.estimatedDemand} 台。`,
      ...(allocated > 0 ? [`已排入 ${allocated} 台由鄰站${borrow ? '調來' : '調出'}因應。`] : []),
      ...(remainingGap > 0 ? [`仍短少 ${remainingGap} 台，建議加派車輛或調高安全庫存。`] : []),
    ]

    alerts.push({
      id: alertId,
      stationId: impact.stationId,
      condition: borrow ? 'empty_forecast' : 'full_forecast',
      severity,
      startedAt: observedAt,
      durationMinutes: 0,
      riskScore,
      priorityScore: rounded(riskScore * 25 + (remainingGap > 0 ? 50 : 0) + Math.min(20, remainingGap / 8 * 20), 1),
      scoreParts: {
        forecast: rounded(riskScore * 25),
        current: remainingGap > 0 ? 50 : 0,
        gap: rounded(Math.min(1, remainingGap / 8) * 20),
        quality: 0,
      },
      dispatchEligible: allocations.length > 0,
      status: 'open',
      reasons,
    })

    for (const allocation of allocations) {
      const neighbour = stationById.get(allocation.neighbourId)
      if (!neighbour) continue
      const fromStation = borrow ? neighbour : station
      const toStation = borrow ? station : neighbour
      const distanceKm = distanceKmBetween(fromStation, toStation) ?? 0
      dispatches.push({
        id: `event-dispatch:${impact.eventId}:${impact.phaseIndex}:${impact.stationId}:${allocation.neighbourId}`,
        alertId,
        operation: borrow ? 'deliver_bikes' : 'remove_bikes',
        fromStationId: fromStation.id,
        toStationId: toStation.id,
        bikeCount: allocation.amount,
        distanceKm: rounded(distanceKm, 2),
        priorityScore: rounded(riskScore * 100 - Math.min(15, distanceKm * 1.5), 1),
        reasons: [
          `因應活動「${impact.eventName}」預期人潮，提前由「${displayStationName(fromStation.name)}」搬運 ${allocation.amount} 台到「${displayStationName(toStation.name)}」。`,
          '本建議為活動前的預先補位，尚未派發，仍需人工確認。',
        ],
        status: 'proposed',
        requiresOperatorReview: true,
      })
    }
  }

  return { alerts, dispatches }
}
