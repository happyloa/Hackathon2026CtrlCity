import assert from 'node:assert/strict'
import { stat, readFile } from 'node:fs/promises'
import test from 'node:test'

const evaluationUrl = new URL('../server/data/forecast-evaluation.json', import.meta.url)
const evaluation = JSON.parse(await readFile(evaluationUrl, 'utf8'))
const HORIZONS = ['30', '60', '120']

function assertRatio(value, label) {
  assert.equal(typeof value, 'number', `${label} must be numeric`)
  assert.ok(Number.isFinite(value), `${label} must be finite`)
  assert.ok(value >= 0 && value <= 1, `${label} must be between 0 and 1`)
}

test('forecast evaluation uses a chronological train, validation, and held-out test split', () => {
  assert.equal(evaluation.schemaVersion, '1.0')
  assert.equal(evaluation.model?.version, 'historical-profile-heuristic-v1')
  assert.match(evaluation.timeSplit?.train ?? '', /2026-01-01.*2026-04-30/)
  assert.match(evaluation.timeSplit?.validation ?? '', /2026-05-01.*2026-05-31/)
  assert.match(evaluation.timeSplit?.test ?? '', /2026-06-01.*2026-06-30/)
  assert.equal(evaluation.thresholdSelection?.split, 'validation')
  assert.ok(evaluation.cohort?.stationCount > 100, 'evaluation cohort should cover a meaningful station sample')
  assert.ok(evaluation.data?.trainingProfiles > 1_000, 'training profiles should be populated from Jan-Apr data')
})

test('held-out metrics are complete, bounded, and contain no source snapshots', async () => {
  const file = await stat(evaluationUrl)
  assert.ok(file.size < 50 * 1024, 'evaluation artifact must remain a compact metrics-only file')
  assert.equal('stations' in evaluation, false, 'evaluation artifact must not include raw station records')
  assert.equal('snapshots' in evaluation, false, 'evaluation artifact must not include raw snapshots')

  for (const horizon of HORIZONS) {
    const validation = evaluation.validation?.horizons?.[horizon]
    const heldOut = evaluation.test?.horizons?.[horizon]
    assert.ok(validation, `missing ${horizon}-minute validation metrics`)
    assert.ok(heldOut, `missing ${horizon}-minute held-out metrics`)
    assertRatio(validation.threshold, `${horizon}-minute validation threshold`)
    assert.equal(heldOut.threshold, validation.threshold, `${horizon}-minute test threshold must be frozen from validation`)

    for (const result of [validation, heldOut]) {
      assert.ok(result.inventoryIssue.predictionCount > 1_000, `${horizon}-minute evaluation needs sufficient coverage`)
      for (const field of ['precision', 'recall', 'f1', 'specificity', 'alertRate']) {
        assertRatio(result.inventoryIssue[field], `${horizon}-minute inventory ${field}`)
      }
      assertRatio(result.probabilityQuality.inventoryIssue.baseRate, `${horizon}-minute base rate`)
      assertRatio(result.probabilityQuality.inventoryIssue.meanRisk, `${horizon}-minute mean risk`)
      assert.ok(result.probabilityQuality.inventoryIssue.brierScore >= 0, `${horizon}-minute brier score must be non-negative`)
      assert.ok(result.probabilityQuality.inventoryIssue.logLoss >= 0, `${horizon}-minute log loss must be non-negative`)
    }
  }
})
