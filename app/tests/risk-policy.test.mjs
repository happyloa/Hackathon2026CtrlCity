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
  assert.equal(riskLevelFor(.449, '60'), 'medium')
  assert.equal(riskLevelFor(.45, '60'), 'high')
  assert.equal(riskLevelFor(.65, '60'), 'critical')
  assert.equal(riskLevelFor(.4, '120'), 'high')
  assert.equal(alertSeverityFor(.2, '60'), 'normal')
  assert.equal(alertSeverityFor(.2, '60', { currentFailure: true }), 'critical')
})
