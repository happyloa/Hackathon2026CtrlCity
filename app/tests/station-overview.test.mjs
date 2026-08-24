import assert from 'node:assert/strict'
import test from 'node:test'

import { stationOverviewStatus } from '../shared/station-overview.ts'

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
