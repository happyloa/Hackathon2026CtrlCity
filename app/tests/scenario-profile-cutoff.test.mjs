import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createScenarioProfileStats,
  profileKey,
  updateScenarioProfileStats,
} from '../scripts/scenario-profile-cutoff.mjs'

function snapshot(epoch, currentState, availableBikes, availableDocks) {
  return {
    id: 'station-a',
    slot: 18,
    epoch,
    currentState,
    availableBikes,
    availableDocks,
  }
}

test('replay profiles learn only from buckets strictly before each scenario cutoff', () => {
  const firstCutoff = Date.parse('2026-04-26T17:00:00+08:00')
  const secondCutoff = Date.parse('2026-04-27T09:00:00+08:00')
  const scenarios = [{ epoch: firstCutoff }, { epoch: secondCutoff }]
  const profilesByScenario = createScenarioProfileStats(scenarios)

  updateScenarioProfileStats(
    profilesByScenario,
    scenarios,
    snapshot(firstCutoff - 30 * 60_000, 'normal', 8, 12),
  )
  updateScenarioProfileStats(
    profilesByScenario,
    scenarios,
    snapshot(firstCutoff, 'empty', 0, 20),
  )
  updateScenarioProfileStats(
    profilesByScenario,
    scenarios,
    snapshot(secondCutoff - 30 * 60_000, 'unavailable', 0, 0),
  )
  updateScenarioProfileStats(
    profilesByScenario,
    scenarios,
    snapshot(secondCutoff, 'full', 20, 0),
  )

  const key = profileKey('station-a', 18)
  assert.deepEqual(profilesByScenario.get(firstCutoff).get(key), {
    observations: 1,
    bikesSum: 8,
    docksSum: 12,
    empty: 0,
    full: 0,
    unavailable: 0,
  })
  assert.deepEqual(profilesByScenario.get(secondCutoff).get(key), {
    observations: 2,
    bikesSum: 8,
    docksSum: 32,
    empty: 1,
    full: 0,
    unavailable: 1,
  })
})

test('scenario profile accumulators are independent', () => {
  const scenarios = [{ epoch: 100 }, { epoch: 200 }]
  const profilesByScenario = createScenarioProfileStats(scenarios)

  assert.notEqual(profilesByScenario.get(100), profilesByScenario.get(200))
  updateScenarioProfileStats(profilesByScenario, scenarios, snapshot(150, 'normal', 3, 7))
  assert.equal(profilesByScenario.get(100).size, 0)
  assert.equal(profilesByScenario.get(200).size, 1)
})
