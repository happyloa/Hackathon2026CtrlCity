import { displayStationName, type HorizonKey, type StationRisk } from './ops.ts'

export interface NearbyReturnStation {
  stationId: string
  name: string
  district: string
  distanceMeters: number
  availableDocks: number
  predictedDocks: number
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
 * Finds nearby stations where a rider can still return a bike without moving
 * the problem to another station. Distances are straight-line estimates.
 */
export function nearbyReturnStations(
  target: StationRisk,
  stations: readonly StationRisk[],
  horizon: HorizonKey,
  options: { radiusMeters?: number; limit?: number } = {},
): NearbyReturnStation[] {
  const radiusMeters = Math.max(100, options.radiusMeters ?? 600)
  const limit = Math.max(1, options.limit ?? 3)

  return stations
    .filter((station) => station.id !== target.id && station.serviceStatus === 'operational')
    .flatMap((station) => {
      const forecast = station.forecast.horizons[horizon]
      if (forecast.baselineStatus !== 'matched') return []
      const safetyDocks = Math.max(2, Math.ceil(station.totalDocks * .1))
      const projectedDocks = Math.min(station.availableDocks, forecast.predictedDocks)
      const distanceMeters = distanceMetersBetween(target, station)
      if (
        distanceMeters === null
        || distanceMeters > radiusMeters
        || station.currentState === 'full_now'
        || forecast.fullRisk >= forecast.alertThreshold
        || projectedDocks < safetyDocks
      ) return []

      return [{
        stationId: station.id,
        name: displayStationName(station.name),
        district: station.district,
        distanceMeters: Math.round(distanceMeters / 10) * 10,
        availableDocks: station.availableDocks,
        predictedDocks: forecast.predictedDocks,
      }]
    })
    .sort((left, right) => left.distanceMeters - right.distanceMeters
      || right.predictedDocks - left.predictedDocks
      || left.stationId.localeCompare(right.stationId))
    .slice(0, limit)
}
