import { safetyStockFor } from './operational-policy.mjs'
import { displayStationName, type HorizonKey, type StationRisk } from './ops.ts'

export interface NearbyReturnStation {
  stationId: string
  name: string
  district: string
  distanceMeters: number
  availableDocks: number
  predictedDocks: number
}

export interface NearbyBorrowStation {
  stationId: string
  name: string
  district: string
  distanceMeters: number
  availableBikes: number
  predictedBikes: number
}

function hasCoordinates(station: StationRisk): station is StationRisk & { latitude: number; longitude: number } {
  return typeof station.latitude === 'number'
    && Number.isFinite(station.latitude)
    && typeof station.longitude === 'number'
    && Number.isFinite(station.longitude)
}

function distanceMetersBetween(left: StationRisk, right: StationRisk): number | null {
  if (!hasCoordinates(left) || !hasCoordinates(right)) return null
  const radians = (degrees: number) => degrees * Math.PI / 180
  const latitudeDelta = radians(right.latitude - left.latitude)
  const longitudeDelta = radians(right.longitude - left.longitude)
  const haversine = Math.sin(latitudeDelta / 2) ** 2
    + Math.cos(radians(left.latitude)) * Math.cos(radians(right.latitude)) * Math.sin(longitudeDelta / 2) ** 2
  return 6_371_008.8 * 2 * Math.atan2(Math.sqrt(haversine), Math.sqrt(Math.max(0, 1 - haversine)))
}

/**
 * Shared walk for both directions of "where else can this rider go" --
 * returning a bike needs free docks, borrowing one needs available bikes,
 * but the operational/distance/baseline/safety-stock gating is identical
 * modulo which resource (docks vs. bikes) is being checked.
 */
function nearbyStationsWithResource(
  target: StationRisk,
  stations: readonly StationRisk[],
  horizon: HorizonKey,
  resource: 'docks' | 'bikes',
  options: { radiusMeters?: number; limit?: number },
) {
  const radiusMeters = Math.max(100, options.radiusMeters ?? 600)
  const limit = Math.max(1, options.limit ?? 3)
  const isDocks = resource === 'docks'

  return stations
    .filter((station) => station.id !== target.id && station.serviceStatus === 'operational')
    .flatMap((station) => {
      const forecast = station.forecast.horizons[horizon]
      if (forecast.baselineStatus !== 'matched') return []
      const safetyAmount = safetyStockFor(station)
      const availableNow = isDocks ? station.availableDocks : station.availableBikes
      const predicted = isDocks ? forecast.predictedDocks : forecast.predictedBikes
      const projected = Math.min(availableNow, predicted)
      const blockedNow = isDocks ? station.currentState === 'full_now' : station.currentState === 'empty_now'
      const risk = isDocks ? forecast.fullRisk : forecast.emptyRisk
      const distanceMeters = distanceMetersBetween(target, station)
      if (
        distanceMeters === null
        || distanceMeters > radiusMeters
        || blockedNow
        || risk >= forecast.alertThreshold
        || projected < safetyAmount
      ) return []

      return [{
        stationId: station.id,
        name: displayStationName(station.name),
        district: station.district,
        distanceMeters: Math.round(distanceMeters / 10) * 10,
        available: availableNow,
        predicted,
      }]
    })
    .sort((left, right) => left.distanceMeters - right.distanceMeters
      || right.predicted - left.predicted
      || left.stationId.localeCompare(right.stationId))
    .slice(0, limit)
}

/**
 * Finds nearby stations where a rider can still return a bike without moving
 * the problem to another station. Distances are straight-line estimates.
 */
export function nearbyReturnStations(
  target: StationRisk,
  stations: readonly StationRisk[],
  horizon: HorizonKey,
  options: { radiusMeters?: number; limit?: number } = {},
): NearbyReturnStation[] {
  return nearbyStationsWithResource(target, stations, horizon, 'docks', options)
    .map(({ available, predicted, ...rest }) => ({ ...rest, availableDocks: available, predictedDocks: predicted }))
}

/**
 * Finds nearby stations where a rider can still borrow a bike, mirroring
 * `nearbyReturnStations` for the empty/near-empty case.
 */
export function nearbyBorrowStations(
  target: StationRisk,
  stations: readonly StationRisk[],
  horizon: HorizonKey,
  options: { radiusMeters?: number; limit?: number } = {},
): NearbyBorrowStation[] {
  return nearbyStationsWithResource(target, stations, horizon, 'bikes', options)
    .map(({ available, predicted, ...rest }) => ({ ...rest, availableBikes: available, predictedBikes: predicted }))
}
