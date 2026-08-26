import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import {
  ALERT_THRESHOLDS,
  RISK_POLICY_VERSION,
  alertSeverityFor,
  alertThresholdFor,
  riskLevelFor,
} from '../scripts/risk-policy.mjs'

const evaluationUrl = new URL('../data/forecast-evaluation.json', import.meta.url)
const evaluation = JSON.parse(await readFile(evaluationUrl, 'utf8'))

test('shared event-risk policy is frozen to the chronological validation selection', () => {
  assert.equal(RISK_POLICY_VERSION, 'event-risk-policy-v1')
  for (const horizon of ['30', '60', '120']) {
    const selected = evaluation.thresholdSelection.selected[horizon].threshold
    assert.equal(ALERT_THRESHOLDS[horizon], selected)
    assert.equal(alertThresholdFor(horizon), selected)
  }
})

test('risk levels use the shared threshold while current inventory failures remain critical', () => {
  // Derived from the live threshold rather than hardcoded scores: ALERT_THRESHOLDS
  // is a frozen snapshot of the validation-selected value and legitimately moves
  // whenever forecast-evaluation.json is regenerated (see risk-policy.mjs).
  const threshold60 = ALERT_THRESHOLDS['60']
  assert.equal(riskLevelFor(threshold60 - .001, '60'), 'medium')
  assert.equal(riskLevelFor(threshold60, '60'), 'high')
  assert.equal(riskLevelFor(Math.min(1, threshold60 + .2), '60'), 'critical')
  assert.equal(riskLevelFor(ALERT_THRESHOLDS['120'], '120'), 'high')
  assert.equal(alertSeverityFor(.2, '60'), 'normal')
  assert.equal(alertSeverityFor(.2, '60', { currentFailure: true }), 'critical')
})
