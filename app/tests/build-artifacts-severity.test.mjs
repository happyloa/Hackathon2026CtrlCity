import assert from 'node:assert/strict'
import test from 'node:test'

import { detectCriticality } from '../scripts/build-artifacts.mjs'

function station({ serviceStatus = 'operational', currentState = 'normal', emptyRisk = 0.05, fullRisk = 0.05 } = {}) {
  const horizon = { emptyRisk, fullRisk }
  return {
    serviceStatus,
    currentState,
    forecast: { horizons: { 60: horizon } },
  }
}

test('a service-disrupted station is no longer forced to the highest predicted severity', () => {
  const disrupted = station({ serviceStatus: 'official_inactive', emptyRisk: 0.02, fullRisk: 0.02 })
  assert.notEqual(detectCriticality(disrupted), 'critical')
})

test('a currently empty station still reports critical severity regardless of its risk score', () => {
  const empty = station({ currentState: 'empty', emptyRisk: 0.1, fullRisk: 0.1 })
  assert.equal(detectCriticality(empty), 'critical')
})
