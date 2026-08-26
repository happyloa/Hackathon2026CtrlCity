import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createCentralStationPopularityAccumulator,
  createStationPopularityAccumulator,
  stationPopularityProfile,
  updateCentralStationPopularity,
  updateStationPopularity,
} from '../scripts/station-popularity.mjs'
import { stationPopularityMatchKey, taipeiWeekday } from '../shared/station-popularity.ts'

function snapshot(overrides = {}) {
  return {
    id: 'station-1',
    at: '2026-08-03T08:00:00+08:00',
    epoch: Date.UTC(2026, 7, 3, 8),
    slot: 16,
    weekday: 1,
    totalDocks: 10,
    availableBikes: 4,
    availableDocks: 6,
    currentState: 'normal',
    ...overrides,
  }
}

test('groups mean inventory by station, weekday, and hour', () => {
  const snapshots = [snapshot(), snapshot({
    at: '2026-08-03T08:30:00+08:00',
    epoch: Date.UTC(2026, 7, 3, 8, 30),
    slot: 17,
    availableBikes: 6,
    availableDocks: 4,
  })]
  const moments = createStationPopularityAccumulator()
  snapshots.forEach(item => updateStationPopularity(moments, item))
  const accumulator = createCentralStationPopularityAccumulator(moments)
  snapshots.forEach(item => updateCentralStationPopularity(accumulator, item))

  const profile = stationPopularityProfile(accumulator, 'station-1')
  assert.deepEqual(profile[1][8], [1, 5, 5])
  assert.equal(profile[1][9], null)
})

test('counts distinct sample days and excludes unavailable snapshots', () => {
  const snapshots = [snapshot(), snapshot({
    at: '2026-08-10T08:00:00+08:00',
    epoch: Date.UTC(2026, 7, 10, 8),
    availableBikes: 8,
    availableDocks: 2,
  }), snapshot({
    at: '2026-08-17T08:00:00+08:00',
    epoch: Date.UTC(2026, 7, 17, 8),
    availableBikes: 0,
    availableDocks: 0,
    currentState: 'unavailable',
  })]
  const moments = createStationPopularityAccumulator()
  snapshots.forEach(item => updateStationPopularity(moments, item))
  const accumulator = createCentralStationPopularityAccumulator(moments)
  snapshots.forEach(item => updateCentralStationPopularity(accumulator, item))

  assert.deepEqual(stationPopularityProfile(accumulator, 'station-1')[1][8], [2, 6, 4])
})

test('recomputes the displayed mean from observations inside one standard deviation', () => {
  const snapshots = [1, 2, 2, 3, 20].map((bikes, index) => snapshot({
    at: `2026-08-${String(3 + index * 7).padStart(2, '0')}T08:00:00+08:00`,
    epoch: Date.UTC(2026, 7, 3 + index * 7, 8),
    availableBikes: bikes,
    availableDocks: 20 - bikes,
  }))
  const moments = createStationPopularityAccumulator()
  snapshots.forEach(item => updateStationPopularity(moments, item))
  const accumulator = createCentralStationPopularityAccumulator(moments)
  snapshots.forEach(item => updateCentralStationPopularity(accumulator, item))

  assert.deepEqual(stationPopularityProfile(accumulator, 'station-1')[1][8], [5, 2, 18])
})

test('uses Taipei weekday and the same normalized live station key', () => {
  assert.equal(taipeiWeekday(Date.parse('2026-08-23T17:00:00Z')), 1)
  assert.equal(stationPopularityMatchKey({ district: ' 板橋區 ', name: 'YouBike 2.0_捷運新埔站' }), '板橋區|捷運新埔站')
})
