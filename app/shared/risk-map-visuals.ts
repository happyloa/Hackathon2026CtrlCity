import type { ServiceStatus } from '~/shared/ops'
import { NEARBY_STATION_RADII_METERS, STABLE_INVENTORY_TONE_RATIO } from './parameters.mjs'

export interface GeographicPoint {
  id: string
  latitude: number | null
  longitude: number | null
}

export interface StationInventory {
  totalDocks: number
  availableBikes: number
  availableDocks: number
}

export type StableInventoryTone = 'balanced' | 'bike-heavy' | 'dock-heavy'

export interface NeighbourGroup {
  id: string
  latitude: number
  longitude: number
  radiusMeters: number
  memberIds: string[]
}

const EARTH_RADIUS_METERS = 6_371_008.8
function radians(degrees: number): number {
  return degrees * Math.PI / 180
}

function validPoint(point: GeographicPoint): point is GeographicPoint & { latitude: number; longitude: number } {
  return Number.isFinite(point.latitude)
    && Number.isFinite(point.longitude)
    && point.latitude! >= -90
    && point.latitude! <= 90
    && point.longitude! >= -180
    && point.longitude! <= 180
}

function distanceMeters(left: { latitude: number; longitude: number }, right: { latitude: number; longitude: number }): number {
  const latitudeDelta = radians(right.latitude - left.latitude)
  const longitudeDelta = radians(right.longitude - left.longitude)
  const leftLatitude = radians(left.latitude)
  const rightLatitude = radians(right.latitude)
  const haversine = Math.sin(latitudeDelta / 2) ** 2
    + Math.cos(leftLatitude) * Math.cos(rightLatitude) * Math.sin(longitudeDelta / 2) ** 2
  return EARTH_RADIUS_METERS * 2 * Math.atan2(Math.sqrt(haversine), Math.sqrt(Math.max(0, 1 - haversine)))
}

/**
 * Groups stations by a transitive, exact-distance neighbourhood -- stations
 * whose service areas overlap enough that riders would walk to the other one
 * (see "鄰近群" in CONTEXT.md). Callers decide which stations are eligible
 * (e.g. excluding service-disrupted ones); this function only clusters
 * whatever points it is given. A projected grid limits comparisons to nearby
 * cells, keeping the work close to O(n) for the roughly 1,600 stations shown
 * on the map.
 */
export function groupNearbyStations(
  input: readonly GeographicPoint[],
  maximumDistanceMeters = NEARBY_STATION_RADII_METERS.neighbourGroup,
): NeighbourGroup[] {
  const maximumDistance = Number.isFinite(maximumDistanceMeters)
    ? Math.max(1, maximumDistanceMeters)
    : NEARBY_STATION_RADII_METERS.neighbourGroup
  const points = input
    .filter(validPoint)
    .sort((left, right) => left.id.localeCompare(right.id))
  if (points.length < 2) return []

  const referenceLatitude = radians(points.reduce((sum, point) => sum + point.latitude, 0) / points.length)
  const longitudeScale = Math.max(0.01, Math.cos(referenceLatitude))
  const parent = points.map((_, index) => index)
  const cells = new Map<string, number[]>()

  const root = (index: number): number => {
    let cursor = index
    while (parent[cursor] !== cursor) cursor = parent[cursor]!
    while (parent[index] !== index) {
      const next = parent[index]!
      parent[index] = cursor
      index = next
    }
    return cursor
  }
  const join = (left: number, right: number) => {
    const leftRoot = root(left)
    const rightRoot = root(right)
    if (leftRoot === rightRoot) return
    if (leftRoot < rightRoot) parent[rightRoot] = leftRoot
    else parent[leftRoot] = rightRoot
  }

  for (let index = 0; index < points.length; index += 1) {
    const point = points[index]!
    const xMeters = EARTH_RADIUS_METERS * radians(point.longitude) * longitudeScale
    const yMeters = EARTH_RADIUS_METERS * radians(point.latitude)
    const cellX = Math.floor(xMeters / maximumDistance)
    const cellY = Math.floor(yMeters / maximumDistance)

    // Two cells tolerate the tiny longitude-scale drift across New Taipei
    // while still avoiding an all-pairs scan.
    for (let xOffset = -2; xOffset <= 2; xOffset += 1) {
      for (let yOffset = -2; yOffset <= 2; yOffset += 1) {
        const neighbours = cells.get(`${cellX + xOffset}:${cellY + yOffset}`) || []
        for (const neighbourIndex of neighbours) {
          if (distanceMeters(point, points[neighbourIndex]!) <= maximumDistance) join(index, neighbourIndex)
        }
      }
    }

    const key = `${cellX}:${cellY}`
    const bucket = cells.get(key)
    if (bucket) bucket.push(index)
    else cells.set(key, [index])
  }

  const groups = new Map<number, typeof points>()
  for (let index = 0; index < points.length; index += 1) {
    const groupRoot = root(index)
    const group = groups.get(groupRoot)
    if (group) group.push(points[index]!)
    else groups.set(groupRoot, [points[index]!])
  }

  return [...groups.values()]
    .filter(group => group.length > 1)
    .map((group) => {
      const latitude = group.reduce((sum, point) => sum + point.latitude, 0) / group.length
      const longitude = group.reduce((sum, point) => sum + point.longitude, 0) / group.length
      const centre = { latitude, longitude }
      const spread = Math.max(...group.map(point => distanceMeters(centre, point)))
      const memberIds = group.map(point => point.id).sort((left, right) => left.localeCompare(right))
      return {
        id: `neighbour-group:${memberIds.join('|')}`,
        latitude,
        longitude,
        radiusMeters: Math.max(80, Math.round(spread + 45)),
        memberIds,
      }
    })
    .sort((left, right) => left.memberIds[0]!.localeCompare(right.memberIds[0]!))
}

export interface StationForGrouping extends GeographicPoint {
  serviceStatus: ServiceStatus
}

/**
 * The neighbour-group view over the map: every operational station is
 * eligible (not just the ones currently flagged as at-risk), since the green
 * base layer covers all of them and a dispatcher can click anywhere in it.
 * Service-disrupted stations aren't offering service, so they're excluded
 * the same way they're excluded from the green base layer.
 */
export function groupOperationalStations(
  stations: readonly StationForGrouping[],
  maximumDistanceMeters = NEARBY_STATION_RADII_METERS.neighbourGroup,
): NeighbourGroup[] {
  return groupNearbyStations(
    stations.filter(station => station.serviceStatus === 'operational'),
    maximumDistanceMeters,
  )
}

export function stableInventoryTone(station: StationInventory): StableInventoryTone {
  const capacity = Math.max(0, Number.isFinite(station.totalDocks) ? station.totalDocks : 0)
  if (!capacity) return 'balanced'
  const bikes = Math.max(0, Number.isFinite(station.availableBikes) ? station.availableBikes : 0)
  const docks = Math.max(0, Number.isFinite(station.availableDocks) ? station.availableDocks : 0)
  const bikeHeavy = bikes >= capacity * STABLE_INVENTORY_TONE_RATIO
  const dockHeavy = docks >= capacity * STABLE_INVENTORY_TONE_RATIO
  if (bikeHeavy && dockHeavy) return bikes >= docks ? 'bike-heavy' : 'dock-heavy'
  if (bikeHeavy) return 'bike-heavy'
  if (dockHeavy) return 'dock-heavy'
  return 'balanced'
}
