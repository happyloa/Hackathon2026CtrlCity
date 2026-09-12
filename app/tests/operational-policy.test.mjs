import assert from 'node:assert/strict'
import test from 'node:test'

import {
  SEVERITY_LEVELS,
  refillAmountFor,
  safetyStockFor,
  stationSeverityFor,
} from '../shared/operational-policy.mjs'
import { LIVE_SNAPSHOT_POLICY, NEAR_EMPTY_BIKES } from '../shared/parameters.mjs'

function station(overrides = {}) {
  return {
    serviceStatus: 'operational',
    totalDocks: 20,
    availableBikes: 10,
    availableDocks: 10,
    ...overrides,
  }
}

test('service disruption outranks every inventory number, including a full or empty snapshot', () => {
  assert.equal(stationSeverityFor(station({ serviceStatus: 'official_inactive', availableBikes: 0, availableDocks: 0 })), SEVERITY_LEVELS.SERVICE_DISRUPTION)
  assert.equal(stationSeverityFor(station({ serviceStatus: 'suspected_unavailable', availableBikes: 20, availableDocks: 0 })), SEVERITY_LEVELS.SERVICE_DISRUPTION)
})

test('a full station and a fully empty station are mutually exclusive severities', () => {
  assert.equal(stationSeverityFor(station({ availableBikes: 5, availableDocks: 0 })), SEVERITY_LEVELS.FULL)
  assert.equal(stationSeverityFor(station({ availableBikes: 0, availableDocks: 5 })), SEVERITY_LEVELS.EMPTY)
  // A station with neither bikes nor docks available is full, not empty: docks are checked first.
  assert.equal(stationSeverityFor(station({ availableBikes: 0, availableDocks: 0 })), SEVERITY_LEVELS.FULL)
})

test('near-empty is judged on an absolute bike count, independent of station size', () => {
  assert.equal(stationSeverityFor(station({ totalDocks: 60, availableBikes: 1, availableDocks: 40 })), SEVERITY_LEVELS.NEAR_EMPTY)
  assert.equal(stationSeverityFor(station({ totalDocks: 4, availableBikes: 1, availableDocks: 2 })), SEVERITY_LEVELS.NEAR_EMPTY)
})

test('the near-empty boundary is the one 缺車 line the whole system shares', () => {
  // The map coloured by NEAR_EMPTY_BIKES while every list used
  // lowBikesThreshold, and the two held different numbers -- so the map showed
  // strictly fewer 缺車 stations than the lists that claimed the same standard.
  assert.equal(NEAR_EMPTY_BIKES, LIVE_SNAPSHOT_POLICY.lowBikesThreshold, '地圖與清單必須共用同一條缺車門檻')
  // Compared with `<`: 低於 3 台 means the last qualifying station has 2.
  const last = NEAR_EMPTY_BIKES - 1
  assert.equal(stationSeverityFor(station({ totalDocks: 60, availableBikes: last, availableDocks: 40 })), SEVERITY_LEVELS.NEAR_EMPTY)
  assert.notEqual(stationSeverityFor(station({ totalDocks: 60, availableBikes: NEAR_EMPTY_BIKES, availableDocks: 40 })), SEVERITY_LEVELS.NEAR_EMPTY)
})

test('low is judged on a ratio of total docks, with the halfway point itself counted as normal', () => {
  assert.equal(stationSeverityFor(station({ totalDocks: 10, availableBikes: 4, availableDocks: 4 })), SEVERITY_LEVELS.LOW)
  assert.equal(stationSeverityFor(station({ totalDocks: 10, availableBikes: 5, availableDocks: 4 })), SEVERITY_LEVELS.NORMAL)
})

test('a well-stocked station is normal', () => {
  assert.equal(stationSeverityFor(station({ totalDocks: 20, availableBikes: 15, availableDocks: 5 })), SEVERITY_LEVELS.NORMAL)
})

test('refill amount tops a station up to its safety stock, not merely past the near-empty threshold', () => {
  const bigStation = station({ totalDocks: 60 })
  const stockRequired = safetyStockFor(bigStation)
  assert.equal(stockRequired, 9) // max(3, ceil(60 * 0.15))
  assert.equal(refillAmountFor(bigStation, 1), stockRequired - 1)
  assert.notEqual(refillAmountFor(bigStation, 1), 1) // not "just enough to clear the 3-bike threshold"
})

test('refill amount never goes negative once a station already meets its safety stock', () => {
  const bigStation = station({ totalDocks: 60 })
  assert.equal(refillAmountFor(bigStation, safetyStockFor(bigStation)), 0)
  assert.equal(refillAmountFor(bigStation, 50), 0)
})

test('safety stock is a single 15%-of-capacity implementation with a 3-bike floor', () => {
  assert.equal(safetyStockFor(station({ totalDocks: 10 })), 3) // max(3, ceil(10 * 0.15))
  assert.equal(safetyStockFor(station({ totalDocks: 20 })), 3) // max(3, ceil(20 * 0.15))
  assert.equal(safetyStockFor(station({ totalDocks: 60 })), 9) // max(3, ceil(60 * 0.15))
})
