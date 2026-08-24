import assert from 'node:assert/strict'
import test from 'node:test'

import {
  clusterNearbyRiskStations,
  stableInventoryTone,
} from '../shared/risk-map-visuals.ts'

function point(id, latitude, longitude) {
  return { id, latitude, longitude }
}

test('clusters only risk stations connected within 300 metres and is input-order stable', () => {
  const stations = [
    point('a', 25, 121.5),
    point('b', 25.0018, 121.5),
    point('c', 25.0036, 121.5),
    point('far', 25.02, 121.5),
  ]
  const expected = clusterNearbyRiskStations(stations)

  assert.equal(expected.length, 1)
  assert.deepEqual(expected[0].memberIds, ['a', 'b', 'c'])
  assert.ok(expected[0].radiusMeters >= 80)
  assert.deepEqual(clusterNearbyRiskStations([...stations].reverse()), expected)
})

test('does not draw a neighbourhood for singletons or invalid coordinates', () => {
  assert.deepEqual(clusterNearbyRiskStations([
    point('valid', 25, 121.5),
    point('far', 25.01, 121.5),
    point('invalid', null, 121.5),
  ]), [])
})

test('classifies stable station inventory at the inclusive two-thirds boundary', () => {
  assert.equal(stableInventoryTone({ totalDocks: 30, availableBikes: 20, availableDocks: 10 }), 'bike-heavy')
  assert.equal(stableInventoryTone({ totalDocks: 30, availableBikes: 10, availableDocks: 20 }), 'dock-heavy')
  assert.equal(stableInventoryTone({ totalDocks: 30, availableBikes: 19, availableDocks: 11 }), 'balanced')
  assert.equal(stableInventoryTone({ totalDocks: 0, availableBikes: 0, availableDocks: 0 }), 'balanced')
})
