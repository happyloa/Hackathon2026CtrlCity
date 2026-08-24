import { computed, onMounted, toValue, watch, type MaybeRefOrGetter } from 'vue'
import {
  applyDistrictLocationDefault,
  createDistrictSelectionState,
  geolocationFailureFromCode,
  markDistrictLocationAttempted,
  resolveNewTaipeiDistrict,
  selectDistrictManually,
  shouldRequestDistrictLocation,
  syncDistrictFromContext as syncSelectionFromContext,
  type DistrictLocationMatch,
  type DistrictSelectionState,
  type GeographicCoordinates,
  type GeolocationFailure,
} from '~/shared/district-location'
import type { StationRisk } from '~/shared/ops'

export type DistrictLocationStatus =
  | 'idle'
  | 'locating'
  | 'waiting_for_stations'
  | 'matched'
  | 'outside_service_area'
  | 'permission_denied'
  | 'position_unavailable'
  | 'timed_out'
  | 'failed'
  | 'unavailable'
  | 'skipped'

interface GeolocationPositionLike {
  coords: GeographicCoordinates & { accuracy?: number }
}

interface GeolocationErrorLike {
  code?: number
}

export interface BrowserGeolocation {
  getCurrentPosition: (
    success: (position: GeolocationPositionLike) => void,
    failure?: (error: GeolocationErrorLike) => void,
    options?: { enableHighAccuracy?: boolean; timeout?: number; maximumAge?: number },
  ) => void
}

export interface UseDistrictSelectionOptions {
  stations: MaybeRefOrGetter<readonly StationRisk[] | null | undefined>
  districts?: MaybeRefOrGetter<readonly string[] | null | undefined>
  initialDistrict?: MaybeRefOrGetter<string | null | undefined>
  maximumNearestStationDistanceKm?: number
  autoLocate?: boolean
  geolocation?: BrowserGeolocation | null
}

const STATE_KEY = 'district-selection:v1'
const STATUS_KEY = 'district-location-status:v1'
const MATCH_KEY = 'district-location-match:v1'
const PENDING_KEY = 'district-location-pending:v1'

function statusForFailure(failure: GeolocationFailure): DistrictLocationStatus {
  return failure
}

function browserGeolocation(): BrowserGeolocation | null {
  if (typeof navigator === 'undefined' || !navigator.geolocation) return null
  return navigator.geolocation as BrowserGeolocation
}

/**
 * Shared district scope for the operator pages. Automatic geolocation is a
 * one-time default; assigning selectedDistrict is always treated as a manual
 * decision and can never be overwritten by a delayed location response.
 */
export function useDistrictSelection(options: UseDistrictSelectionOptions) {
  const initialDistrict = toValue(options.initialDistrict) ?? ''
  const selectionState = useState<DistrictSelectionState>(STATE_KEY, () => createDistrictSelectionState(initialDistrict))
  const locationStatus = useState<DistrictLocationStatus>(STATUS_KEY, () => 'idle')
  const locationMatch = useState<DistrictLocationMatch | null>(MATCH_KEY, () => null)
  const pendingCoordinates = useState<GeographicCoordinates | null>(PENDING_KEY, () => null)

  selectionState.value = syncSelectionFromContext(selectionState.value, initialDistrict)

  const selectedDistrict = computed<string>({
    get: () => selectionState.value.district,
    set: (district) => {
      selectionState.value = selectDistrictManually(selectionState.value, district)
      pendingCoordinates.value = null
      locationStatus.value = 'skipped'
    },
  })

  const locationMessage = computed(() => {
    if (locationStatus.value === 'matched' && locationMatch.value) {
      return `已依附近站點定位至${locationMatch.value.district}`
    }
    if (locationStatus.value === 'outside_service_area') return '定位位置不在新北站點的合理範圍，顯示全部行政區'
    if (locationStatus.value === 'permission_denied') return '未取得定位權限，顯示全部行政區'
    if (locationStatus.value === 'position_unavailable') return '目前無法取得位置，顯示全部行政區'
    if (locationStatus.value === 'timed_out') return '定位逾時，顯示全部行政區'
    if (locationStatus.value === 'failed') return '定位失敗，顯示全部行政區'
    if (locationStatus.value === 'unavailable') return '此瀏覽器不支援定位，顯示全部行政區'
    if (locationStatus.value === 'waiting_for_stations') return '已取得位置，等待站點資料'
    if (locationStatus.value === 'locating') return '正在判斷所在行政區'
    return ''
  })

  function applyPendingCoordinates(): DistrictLocationMatch | null {
    const coordinates = pendingCoordinates.value
    if (!coordinates) return null
    if (selectionState.value.hasManualSelection || selectionState.value.source === 'context') {
      pendingCoordinates.value = null
      locationStatus.value = 'skipped'
      return null
    }

    const stations = toValue(options.stations) ?? []
    if (stations.length === 0) {
      locationStatus.value = 'waiting_for_stations'
      return null
    }
    const match = resolveNewTaipeiDistrict(coordinates, stations, {
      maximumNearestStationDistanceKm: options.maximumNearestStationDistanceKm,
      allowedDistricts: toValue(options.districts) ?? undefined,
    })
    selectionState.value = applyDistrictLocationDefault(selectionState.value, match)
    locationMatch.value = match
    pendingCoordinates.value = null
    locationStatus.value = match ? 'matched' : 'outside_service_area'
    return match
  }

  async function requestLocationDefault(): Promise<DistrictLocationMatch | null> {
    if (!shouldRequestDistrictLocation(selectionState.value)) return locationMatch.value
    selectionState.value = markDistrictLocationAttempted(selectionState.value)

    const hasInjectedProvider = Object.prototype.hasOwnProperty.call(options, 'geolocation')
    const geolocation = hasInjectedProvider ? options.geolocation ?? null : browserGeolocation()
    if (!geolocation) {
      selectionState.value = applyDistrictLocationDefault(selectionState.value, null)
      locationMatch.value = null
      locationStatus.value = 'unavailable'
      return null
    }

    locationStatus.value = 'locating'
    return await new Promise((resolve) => {
      geolocation.getCurrentPosition((position) => {
        pendingCoordinates.value = {
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
          accuracyMeters: position.coords.accuracyMeters ?? position.coords.accuracy,
        }
        resolve(applyPendingCoordinates())
      }, (error) => {
        if (selectionState.value.hasManualSelection || selectionState.value.source === 'context') {
          locationStatus.value = 'skipped'
          resolve(null)
          return
        }
        const failure = geolocationFailureFromCode(error.code)
        selectionState.value = applyDistrictLocationDefault(selectionState.value, null)
        locationMatch.value = null
        locationStatus.value = statusForFailure(failure)
        resolve(null)
      }, {
        enableHighAccuracy: false,
        timeout: 6_000,
        maximumAge: 300_000,
      })
    })
  }

  function selectDistrict(district: string): void {
    selectedDistrict.value = district
  }

  function syncDistrictFromContext(district: string): void {
    const knownDistricts = toValue(options.districts) ?? []
    const normalizedDistrict = district.normalize('NFKC').trim()
    const validDistrict = normalizedDistrict && knownDistricts.length > 0 && !knownDistricts.includes(normalizedDistrict)
      ? ''
      : normalizedDistrict
    const next = syncSelectionFromContext(selectionState.value, validDistrict)
    if (next === selectionState.value) return
    selectionState.value = next
    pendingCoordinates.value = null
    locationMatch.value = null
    locationStatus.value = 'skipped'
  }

  watch(() => toValue(options.stations), () => {
    if (pendingCoordinates.value) applyPendingCoordinates()
  })

  watch(() => toValue(options.districts), (districts) => {
    if (!districts?.length || !selectionState.value.district) return
    if (districts.includes(selectionState.value.district)) return
    syncDistrictFromContext('')
    if (options.autoLocate !== false && import.meta.client) void requestLocationDefault()
  }, { immediate: true })

  if (options.autoLocate !== false) {
    onMounted(() => { void requestLocationDefault() })
  }

  return {
    selectedDistrict,
    selectionSource: computed(() => selectionState.value.source),
    locationAttempted: computed(() => selectionState.value.locationAttempted),
    locationStatus,
    locationMessage,
    locationMatch,
    requestLocationDefault,
    selectDistrict,
    syncDistrictFromContext,
  }
}
