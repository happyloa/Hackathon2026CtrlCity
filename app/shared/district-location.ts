import type { StationRisk } from './ops.ts'

export interface GeographicCoordinates {
  latitude: number
  longitude: number
  accuracyMeters?: number
}

export interface DistrictLocationPolicy {
  maximumNearestStationDistanceKm: number
  maximumLocationAccuracyMeters: number
  highConfidenceDistanceKm: number
  mediumConfidenceDistanceKm: number
  neighborCount: number
  minimumNearbyDistrictAgreement: number
}

export interface DistrictLocationMatch {
  district: string
  nearestStationId: string
  nearestStationName: string
  distanceKm: number
  confidence: 'high' | 'medium' | 'low'
  nearbyDistrictAgreement: number
  method: 'nearest_new_taipei_station'
}

export type DistrictSelectionSource = 'all' | 'context' | 'location' | 'manual'

export interface DistrictSelectionState {
  district: string
  source: DistrictSelectionSource
  locationAttempted: boolean
  hasManualSelection: boolean
}

export const DEFAULT_DISTRICT_LOCATION_POLICY: Readonly<DistrictLocationPolicy> = Object.freeze({
  maximumNearestStationDistanceKm: 3,
  maximumLocationAccuracyMeters: 5_000,
  highConfidenceDistanceKm: 0.75,
  mediumConfidenceDistanceKm: 1.5,
  neighborCount: 5,
  minimumNearbyDistrictAgreement: 0.6,
})

function finite(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback
}

function rounded(value: number, digits = 2): number {
  const scale = 10 ** digits
  return Math.round(value * scale) / scale
}

function normalizedDistrict(value: string | null | undefined): string {
  return value?.normalize('NFKC').trim() ?? ''
}

function validCoordinates(coordinates: GeographicCoordinates): boolean {
  return Number.isFinite(coordinates.latitude)
    && coordinates.latitude >= -90
    && coordinates.latitude <= 90
    && Number.isFinite(coordinates.longitude)
    && coordinates.longitude >= -180
    && coordinates.longitude <= 180
}

function stationHasCoordinates(station: StationRisk): station is StationRisk & { latitude: number; longitude: number } {
  return typeof station.latitude === 'number'
    && Number.isFinite(station.latitude)
    && station.latitude >= -90
    && station.latitude <= 90
    && typeof station.longitude === 'number'
    && Number.isFinite(station.longitude)
    && station.longitude >= -180
    && station.longitude <= 180
}

export function geographicDistanceKm(left: GeographicCoordinates, right: GeographicCoordinates): number | null {
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

/**
 * Resolves a location without geocoding by comparing it with the current New
 * Taipei station set. A point farther than the confidence boundary returns null
 * so callers can safely keep the all-district view.
 */
export function resolveNewTaipeiDistrict(
  coordinates: GeographicCoordinates,
  stations: readonly StationRisk[],
  options: Partial<DistrictLocationPolicy> & { allowedDistricts?: readonly string[] } = {},
): DistrictLocationMatch | null {
  if (!validCoordinates(coordinates)) return null
  const maximumDistanceKm = Math.max(0.1, finite(
    options.maximumNearestStationDistanceKm ?? DEFAULT_DISTRICT_LOCATION_POLICY.maximumNearestStationDistanceKm,
    DEFAULT_DISTRICT_LOCATION_POLICY.maximumNearestStationDistanceKm,
  ))
  const maximumLocationAccuracyMeters = Math.max(0, finite(
    options.maximumLocationAccuracyMeters ?? DEFAULT_DISTRICT_LOCATION_POLICY.maximumLocationAccuracyMeters,
    DEFAULT_DISTRICT_LOCATION_POLICY.maximumLocationAccuracyMeters,
  ))
  if (typeof coordinates.accuracyMeters === 'number'
    && (!Number.isFinite(coordinates.accuracyMeters)
      || coordinates.accuracyMeters < 0
      || coordinates.accuracyMeters > maximumLocationAccuracyMeters)) return null
  const highConfidenceDistanceKm = Math.min(maximumDistanceKm, Math.max(0, finite(
    options.highConfidenceDistanceKm ?? DEFAULT_DISTRICT_LOCATION_POLICY.highConfidenceDistanceKm,
    DEFAULT_DISTRICT_LOCATION_POLICY.highConfidenceDistanceKm,
  )))
  const mediumConfidenceDistanceKm = Math.min(maximumDistanceKm, Math.max(highConfidenceDistanceKm, finite(
    options.mediumConfidenceDistanceKm ?? DEFAULT_DISTRICT_LOCATION_POLICY.mediumConfidenceDistanceKm,
    DEFAULT_DISTRICT_LOCATION_POLICY.mediumConfidenceDistanceKm,
  )))
  const neighborCount = Math.max(1, Math.round(finite(
    options.neighborCount ?? DEFAULT_DISTRICT_LOCATION_POLICY.neighborCount,
    DEFAULT_DISTRICT_LOCATION_POLICY.neighborCount,
  )))
  const minimumNearbyDistrictAgreement = Math.min(1, Math.max(0, finite(
    options.minimumNearbyDistrictAgreement ?? DEFAULT_DISTRICT_LOCATION_POLICY.minimumNearbyDistrictAgreement,
    DEFAULT_DISTRICT_LOCATION_POLICY.minimumNearbyDistrictAgreement,
  )))
  const normalizedAllowedDistricts = options.allowedDistricts?.map(normalizedDistrict).filter(Boolean) ?? []
  const allowedDistricts = normalizedAllowedDistricts.length > 0 ? new Set(normalizedAllowedDistricts) : null

  const nearest = stations.flatMap((station) => {
    const district = normalizedDistrict(station.district)
    if (!district || !stationHasCoordinates(station) || (allowedDistricts && !allowedDistricts.has(district))) return []
    const distanceKm = geographicDistanceKm(coordinates, station)
    return distanceKm === null ? [] : [{ station, district, distanceKm }]
  }).sort((left, right) => left.distanceKm - right.distanceKm
    || left.station.id.localeCompare(right.station.id))

  const match = nearest[0]
  if (!match || match.distanceKm > maximumDistanceKm) return null
  const neighbors = nearest.slice(0, neighborCount)
  const sameDistrict = neighbors.filter(item => item.district === match.district).length
  const nearbyDistrictAgreement = sameDistrict / neighbors.length
  const confidenceDistanceKm = Math.max(match.distanceKm, (coordinates.accuracyMeters ?? 0) / 1_000)
  const confidence = confidenceDistanceKm <= highConfidenceDistanceKm
    ? 'high'
    : confidenceDistanceKm <= mediumConfidenceDistanceKm ? 'medium' : 'low'
  if (confidence === 'low' || nearbyDistrictAgreement < minimumNearbyDistrictAgreement) return null

  return {
    district: match.district,
    nearestStationId: match.station.id,
    nearestStationName: match.station.name,
    distanceKm: rounded(match.distanceKm),
    confidence,
    nearbyDistrictAgreement: rounded(nearbyDistrictAgreement, 2),
    method: 'nearest_new_taipei_station',
  }
}

export function createDistrictSelectionState(initialDistrict = ''): DistrictSelectionState {
  const district = normalizedDistrict(initialDistrict)
  return {
    district,
    source: district ? 'context' : 'all',
    locationAttempted: false,
    hasManualSelection: false,
  }
}

export function shouldRequestDistrictLocation(state: DistrictSelectionState): boolean {
  return !state.locationAttempted
    && !state.hasManualSelection
    && state.source === 'all'
    && !state.district
}

export function markDistrictLocationAttempted(state: DistrictSelectionState): DistrictSelectionState {
  return { ...state, locationAttempted: true }
}

export function selectDistrictManually(
  state: DistrictSelectionState,
  district: string,
): DistrictSelectionState {
  return {
    ...state,
    district: normalizedDistrict(district),
    source: 'manual',
    hasManualSelection: true,
  }
}

/** Keeps browser history and shared page state aligned without reclassifying an unchanged manual choice. */
export function syncDistrictFromContext(
  state: DistrictSelectionState,
  district: string,
): DistrictSelectionState {
  const normalized = normalizedDistrict(district)
  if (normalized === state.district) return state
  return {
    ...state,
    district: normalized,
    source: normalized ? 'context' : 'all',
  }
}

/** Applies an automatic default only while the user has not chosen a scope. */
export function applyDistrictLocationDefault(
  state: DistrictSelectionState,
  match: DistrictLocationMatch | null,
): DistrictSelectionState {
  if (state.hasManualSelection || state.source === 'context') return state
  return {
    ...state,
    district: match?.district ?? '',
    source: match ? 'location' : 'all',
    locationAttempted: true,
  }
}

export type GeolocationFailure = 'permission_denied' | 'position_unavailable' | 'timed_out' | 'failed'

export function geolocationFailureFromCode(code: number | null | undefined): GeolocationFailure {
  if (code === 1) return 'permission_denied'
  if (code === 2) return 'position_unavailable'
  if (code === 3) return 'timed_out'
  return 'failed'
}
