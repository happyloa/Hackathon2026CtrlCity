import assert from 'node:assert/strict'
import test from 'node:test'

import {
  applyDistrictLocationDefault,
  createDistrictSelectionState,
  geographicDistanceKm,
  geolocationFailureFromCode,
  markDistrictLocationAttempted,
  resolveNewTaipeiDistrict,
  selectDistrictManually,
  shouldRequestDistrictLocation,
  syncDistrictFromContext,
} from '../shared/district-location.ts'

function station({ id, district, latitude, longitude }) {
  const forecast = {
    targetAt: '',
    baselineBikes: 10,
    baselineDocks: 10,
    predictedBikes: 10,
    predictedDocks: 10,
    emptyRisk: 0,
    fullRisk: 0,
    unavailableRisk: 0,
    riskScore: 0,
    level: 'normal',
    confidence: 'high',
    alertThreshold: 0.45,
    baselineStatus: 'matched',
    baselineCoverage: 'sufficient',
    method: 'historical_baseline_live_inventory',
    sampleSize: 20,
    reasons: [],
  }
  return {
    id,
    name: `${district}-${id}`,
    city: '新北市',
    district,
    latitude,
    longitude,
    totalDocks: 20,
    availableBikes: 10,
    availableDocks: 10,
    capacityGap: 0,
    currentState: 'normal',
    serviceStatus: 'operational',
    qualityFlags: [],
    forecast: { horizons: { 30: { ...forecast }, 60: { ...forecast }, 120: { ...forecast } } },
  }
}

const stations = [
  station({ id: 'banqiao', district: '板橋區', latitude: 25.0114, longitude: 121.4618 }),
  station({ id: 'banqiao-2', district: '板橋區', latitude: 25.0122, longitude: 121.4624 }),
  station({ id: 'banqiao-3', district: '板橋區', latitude: 25.0108, longitude: 121.4612 }),
  station({ id: 'xinzhuang', district: '新莊區', latitude: 25.0362, longitude: 121.4521 }),
  station({ id: 'sanchong', district: '三重區', latitude: 25.0615, longitude: 121.4881 }),
]

test('resolves a nearby point from the closest current New Taipei station', () => {
  const match = resolveNewTaipeiDistrict({ latitude: 25.0114, longitude: 121.4618 }, stations)

  assert.ok(match)
  assert.equal(match.district, '板橋區')
  assert.equal(match.nearestStationId, 'banqiao')
  assert.equal(match.confidence, 'high')
  assert.equal(match.method, 'nearest_new_taipei_station')
  assert.ok(match.distanceKm < 0.1)
})

test('returns no automatic district for invalid, distant, or unavailable station evidence', () => {
  assert.equal(resolveNewTaipeiDistrict({ latitude: Number.NaN, longitude: 121.5 }, stations), null)
  assert.equal(resolveNewTaipeiDistrict({ latitude: 22.6273, longitude: 120.3014 }, stations), null)
  assert.equal(resolveNewTaipeiDistrict({ latitude: 25.012, longitude: 121.462, accuracyMeters: 10_000 }, stations), null)
  assert.equal(resolveNewTaipeiDistrict({ latitude: 25.012, longitude: 121.462 }, []), null)
})

test('honors the current district list and resolves ties deterministically', () => {
  const samePoint = [
    station({ id: 'z-station', district: '板橋區', latitude: 25, longitude: 121.5 }),
    station({ id: 'a-station', district: '中和區', latitude: 25, longitude: 121.5 }),
  ]
  const unrestricted = resolveNewTaipeiDistrict(
    { latitude: 25, longitude: 121.5 },
    samePoint,
    { minimumNearbyDistrictAgreement: 0 },
  )
  const restricted = resolveNewTaipeiDistrict(
    { latitude: 25, longitude: 121.5 },
    samePoint,
    { allowedDistricts: ['板橋區'] },
  )

  assert.equal(unrestricted?.district, '中和區')
  assert.equal(restricted?.district, '板橋區')
})

test('reports bounded geographic distance and rejects low-confidence locations', () => {
  const oneDegree = geographicDistanceKm(
    { latitude: 25, longitude: 121.5 },
    { latitude: 26, longitude: 121.5 },
  )
  const lowConfidence = resolveNewTaipeiDistrict(
    { latitude: 24.992, longitude: 121.4618 },
    stations,
    { maximumNearestStationDistanceKm: 3 },
  )

  assert.ok(oneDegree && oneDegree > 111 && oneDegree < 112)
  assert.equal(lowConfidence, null)
})

test('rejects a district when nearby station evidence is split across boundaries', () => {
  const boundaryStations = [
    station({ id: 'a', district: '永和區', latitude: 25, longitude: 121.5 }),
    station({ id: 'b', district: '中和區', latitude: 25.0001, longitude: 121.5 }),
    station({ id: 'c', district: '新店區', latitude: 25.0002, longitude: 121.5 }),
  ]

  assert.equal(resolveNewTaipeiDistrict({ latitude: 25, longitude: 121.5 }, boundaryStations), null)
})

test('requests location only once and never overwrites a later manual choice', () => {
  const match = resolveNewTaipeiDistrict({ latitude: 25.012, longitude: 121.462 }, stations)
  let state = createDistrictSelectionState()

  assert.equal(shouldRequestDistrictLocation(state), true)
  state = markDistrictLocationAttempted(state)
  assert.equal(shouldRequestDistrictLocation(state), false)
  state = applyDistrictLocationDefault(state, match)
  assert.equal(state.district, '板橋區')
  assert.equal(state.source, 'location')

  state = selectDistrictManually(state, '新莊區')
  state = applyDistrictLocationDefault(state, match)
  assert.equal(state.district, '新莊區')
  assert.equal(state.source, 'manual')
  assert.equal(state.hasManualSelection, true)
})

test('explicit URL context skips automatic location and browser errors stay explainable', () => {
  let state = createDistrictSelectionState('三重區')

  assert.equal(shouldRequestDistrictLocation(state), false)
  assert.equal(applyDistrictLocationDefault(state, null), state)
  state = selectDistrictManually(state, '板橋區')
  assert.equal(syncDistrictFromContext(state, '板橋區'), state)
  state = syncDistrictFromContext(state, '新莊區')
  assert.equal(state.district, '新莊區')
  assert.equal(state.source, 'context')
  assert.equal(state.hasManualSelection, true)
  assert.equal(geolocationFailureFromCode(1), 'permission_denied')
  assert.equal(geolocationFailureFromCode(2), 'position_unavailable')
  assert.equal(geolocationFailureFromCode(3), 'timed_out')
  assert.equal(geolocationFailureFromCode(undefined), 'failed')
})
