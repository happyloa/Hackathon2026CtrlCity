import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const impact = JSON.parse(await readFile(new URL('../data/operational-impact.json', import.meta.url), 'utf8'))

test('operational impact reports held-out forecast evidence without raw snapshots', () => {
  assert.equal(impact.schemaVersion, '1.0')
  assert.equal(impact.forecastHoldout.split, '2026-06')
  assert.ok(impact.forecastHoldout.cohortStations > 100)
  assert.equal('stations' in impact, false)
  for (const horizon of ['30', '60', '120']) {
    const result = impact.forecastHoldout.horizons[horizon]
    assert.equal(result.leadTimeMinutes, Number(horizon))
    assert.ok(result.evaluatedSnapshots > 1_000)
    assert.ok(result.correctlyFlaggedSnapshots <= result.issueSnapshots)
    for (const metric of ['precision', 'recall', 'f1']) {
      assert.ok(result[metric] >= 0 && result[metric] <= 1)
    }
  }
})

test('dispatch simulation is bounded and explicitly counterfactual', () => {
  assert.match(impact.evidencePolicy.dispatch, /反事實試算/)
  assert.match(impact.evidencePolicy.dispatch, /完整執行建議量/)
  assert.match(impact.evidencePolicy.disclaimer, /不代表/)
  const scenarios = Object.values(impact.dispatchSimulation.scenarios)
  assert.equal(scenarios.length, 3)
  for (const scenario of scenarios) {
    assert.ok(scenario.afterIssueStations <= scenario.beforeIssueStations)
    assert.equal(scenario.immediatelyAddressedStations, scenario.beforeIssueStations - scenario.afterIssueStations)
    assert.ok(scenario.feasibleMoves <= scenario.proposedMoves)
    assert.ok(scenario.reductionRate >= 0 && scenario.reductionRate <= 1)
    assert.ok(scenario.bikesMoved >= 0)
  }
})
