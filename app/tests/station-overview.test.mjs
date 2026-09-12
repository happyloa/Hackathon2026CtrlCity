import assert from 'node:assert/strict'
import test from 'node:test'

import { shortageMetricFor, stationOverviewStatus } from '../shared/station-overview.ts'

function station(overrides = {}) {
  const horizon = { baselineStatus: 'matched' }
  return {
    id: 'station',
    currentState: 'normal',
    serviceStatus: 'operational',
    forecast: { horizons: { 60: horizon } },
    ...overrides,
  }
}

test('classifies service state before inventory and baseline status', () => {
  assert.equal(stationOverviewStatus(station({ serviceStatus: 'official_inactive' })), 'service')
  assert.equal(stationOverviewStatus(station({ currentState: 'unavailable' })), 'service')
  assert.equal(stationOverviewStatus(station(), { condition: 'unavailable' }), 'service')
})

test('classifies current and forecast inventory risk', () => {
  assert.equal(stationOverviewStatus(station({ currentState: 'empty_now' })), 'empty')
  assert.equal(stationOverviewStatus(station(), { condition: 'empty_forecast' }), 'empty')
  assert.equal(stationOverviewStatus(station({ currentState: 'full_now' })), 'full')
  assert.equal(stationOverviewStatus(station(), { condition: 'full_forecast' }), 'full')
})

test('separates stable stations from stations without a baseline', () => {
  assert.equal(stationOverviewStatus(station()), 'stable')
  assert.equal(stationOverviewStatus(station({ forecast: { horizons: { 60: { baselineStatus: 'unmatched' } } } })), 'unknown')
})

import { stationStatusDurationMinutes } from '../shared/station-overview.ts'

const minute = 60_000
const empty = station({ currentState: 'empty_now', availableBikes: 0 })
const snapshot = (at, bikes = 0, docks = 10) => ({ at: at * minute, bikes, docks })

test('counts only the latest continuous shortage and rounds down to minutes', () => {
  assert.equal(stationStatusDurationMinutes(empty, [snapshot(0), snapshot(5, 2), snapshot(10), snapshot(15)], 17.9 * minute), 7)
  const full = station({ currentState: 'full_now', availableDocks: 0 })
  assert.equal(stationStatusDurationMinutes(full, [snapshot(10, 5, 0), snapshot(15, 8, 0)], 18 * minute), 8)
})

test('does not bridge missing snapshots or extrapolate stale history', () => {
  assert.equal(stationStatusDurationMinutes(empty, [snapshot(0), snapshot(15)], 18 * minute), 3)
  assert.equal(stationStatusDurationMinutes(empty, [snapshot(0)], 18 * minute), null)
  assert.equal(stationStatusDurationMinutes(empty, [], 18 * minute), null)
  assert.equal(stationStatusDurationMinutes(empty, [snapshot(15, 1)], 18 * minute), null)
})

test('a shortage clock exists only while the station is actually short', () => {
  // The duration is 異常時長, not 狀態時長: a station that is simply running
  // normally has nothing to time, so anything holding a stored clock (the
  // scheduler's `stateMinutes`, which counts `normal` too) must gate on this.
  assert.equal(shortageMetricFor(empty), 'bikes')
  assert.equal(shortageMetricFor(station({ currentState: 'full_now', availableDocks: 0 })), 'docks')
  assert.equal(shortageMetricFor(station()), null)
  assert.equal(shortageMetricFor(station({ currentState: 'normal', availableBikes: 1 })), null)
  assert.equal(shortageMetricFor(station({ currentState: 'unavailable', availableBikes: 0 })), null)
  assert.equal(shortageMetricFor({ ...empty, serviceStatus: 'official_inactive' }), null)
})

test('handles rounded future slots and excludes forecasts and unavailable stations', () => {
  assert.equal(stationStatusDurationMinutes(empty, [snapshot(15)], 14 * minute), 0)
  assert.equal(stationStatusDurationMinutes(station(), [snapshot(15)], 18 * minute), null)
  assert.equal(stationStatusDurationMinutes({ ...empty, serviceStatus: 'official_inactive' }, [snapshot(15)], 18 * minute), null)
})

import { compareStationValues } from '../shared/station-overview.ts'

test('sorts numerically in either direction with missing data always last', () => {
  for (const [direction, expected] of [['asc', [4, 9, 34, null]], ['desc', [34, 9, 4, null]]]) {
    assert.deepEqual([null, 9, 34, 4].sort((a, b) => compareStationValues(a, b, direction)), expected)
  }
  assert.equal(compareStationValues(null, null, 'asc'), 0)
  assert.ok(compareStationValues('A', 'B', 'asc') < 0)
  assert.ok(compareStationValues('A', 'B', 'desc') > 0)
})
