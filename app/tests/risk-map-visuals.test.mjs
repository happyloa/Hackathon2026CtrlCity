import assert from 'node:assert/strict'
import test from 'node:test'

import {
  groupNearbyStations,
  groupOperationalStations,
  stableInventoryTone,
} from '../shared/risk-map-visuals.ts'

function point(id, latitude, longitude) {
  return { id, latitude, longitude }
}

test('groups stations connected within the default 500 metre radius and is input-order stable', () => {
  const stations = [
    point('a', 25, 121.5),
    point('b', 25.0018, 121.5),
    point('c', 25.0036, 121.5),
    point('far', 25.02, 121.5),
  ]
  const expected = groupNearbyStations(stations)

  assert.equal(expected.length, 1)
  assert.deepEqual(expected[0].memberIds, ['a', 'b', 'c'])
  assert.ok(expected[0].radiusMeters >= 80)
  assert.deepEqual(groupNearbyStations([...stations].reverse()), expected)
})

test('default radius reaches 500 metres, not the old 300 metre cutoff', () => {
  // ~445m apart: joins under the new 500m default but would not have under
  // the previous 300m default.
  const stations = [point('a', 25, 121.5), point('b', 25.004, 121.5)]
  const grouped = groupNearbyStations(stations)

  assert.equal(grouped.length, 1)
  assert.deepEqual(grouped[0].memberIds, ['a', 'b'])
  assert.equal(groupNearbyStations(stations, 300).length, 0)
})

test('does not draw a neighbour group for singletons or invalid coordinates', () => {
  assert.deepEqual(groupNearbyStations([
    point('valid', 25, 121.5),
    point('far', 25.01, 121.5),
    point('invalid', null, 121.5),
  ]), [])
})

test('groupOperationalStations covers every operational station, not just at-risk ones', () => {
  const stations = [
    { ...point('a', 25, 121.5), serviceStatus: 'operational' },
    { ...point('b', 25.0018, 121.5), serviceStatus: 'operational' },
  ]
  const grouped = groupOperationalStations(stations)

  assert.equal(grouped.length, 1)
  assert.deepEqual(grouped[0].memberIds, ['a', 'b'])
})

test('groupOperationalStations excludes service-disrupted stations from grouping', () => {
  const stations = [
    { ...point('a', 25, 121.5), serviceStatus: 'operational' },
    { ...point('b', 25.0018, 121.5), serviceStatus: 'official_inactive' },
  ]

  assert.deepEqual(groupOperationalStations(stations), [])
})

test('classifies stable station inventory at the inclusive two-thirds boundary', () => {
  assert.equal(stableInventoryTone({ totalDocks: 30, availableBikes: 20, availableDocks: 10 }), 'bike-heavy')
  assert.equal(stableInventoryTone({ totalDocks: 30, availableBikes: 10, availableDocks: 20 }), 'dock-heavy')
  assert.equal(stableInventoryTone({ totalDocks: 30, availableBikes: 19, availableDocks: 11 }), 'balanced')
  assert.equal(stableInventoryTone({ totalDocks: 0, availableBikes: 0, availableDocks: 0 }), 'balanced')
})
