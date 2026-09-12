import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { exportReplayStatic } from '../scripts/export-replay-static.mjs'
import { ALERT_THRESHOLDS } from '../scripts/risk-policy.mjs'

test('static export preserves dual-direction dispatches and shards live profiles', async () => {
  const outputDir = await mkdtemp(join(tmpdir(), 'ctrlcity-static-export-'))
  try {
    const result = await exportReplayStatic(outputDir)
    assert.equal(result.scenarios, 3)
    assert.ok(result.liveProfiles.stations >= 1_500)

    const manifest = JSON.parse(await readFile(join(outputDir, 'data', 'live-profile', 'manifest.json'), 'utf8'))
    assert.equal(manifest.schemaVersion, '2.0')
    assert.equal(manifest.modelVersion, 'historical-live-inventory-baseline-v2')
    assert.equal(manifest.timezone, 'Asia/Taipei')
    assert.equal(Object.keys(manifest.slots).length, 48)
    assert.equal(manifest.riskPolicy.alertThresholds['60'], ALERT_THRESHOLDS['60'])
    assert.ok(Array.isArray(manifest.matchKeys))
    assert.equal(manifest.matchKeys.length, result.liveProfiles.stations)
    assert.equal(manifest.stationIds.length, result.liveProfiles.stations)
    assert.equal(Object.keys(manifest.popularity).length, 7)
    assert.deepEqual(manifest.popularityValueFormat, ['sampleDays', 'meanAvailableBikes', 'meanAvailableDocks'])
    assert.equal('stations' in manifest, false)
    assert.equal(manifest.prediction?.schemaVersion, '1.0')
    assert.equal(manifest.prediction?.primaryHorizonMinutes, 60)
    assert.equal(manifest.prediction?.objective, 'station_empty_or_full_inventory_risk')
    assert.equal(manifest.prediction?.method, 'historical_station_slot_baseline_plus_live_inventory')
    assert.deepEqual(manifest.prediction?.inputPolicy, ['historical_station_slot_profile', 'current_live_inventory', 'page_session_momentum_optional'])
    assert.deepEqual(manifest.prediction?.confidencePolicy, {
      limitedMaxSampleSize: 5,
      sufficientMinSampleSize: 6,
      highConfidenceMinSampleSize: 12,
    })
    assert.equal(manifest.prediction?.coverage?.historicalProfileStations, result.liveProfiles.stations)
    assert.ok(manifest.prediction?.coverage?.populatedStationSlots > 0)

    const slot = JSON.parse(await readFile(join(outputDir, 'data', 'live-profile', 'slot-v2-18.json'), 'utf8'))
    assert.equal(slot.slot, 18)
    assert.ok(Array.isArray(slot.profiles))
    assert.equal(slot.profiles.length, manifest.matchKeys.length)
    // A station with zero train-period observations for this slot (e.g. fully
    // excluded by an operator adjustment window spanning the whole dataset)
    // legitimately falls back to null; see normalizeLiveProfileStation.
    assert.ok(slot.profiles.every(profile => profile === null || (Array.isArray(profile) && profile.length === 6)))
    assert.ok(slot.profiles.some(profile => Array.isArray(profile)), 'at least one station must have a real profile for this slot')
    assert.ok((await stat(join(outputDir, 'data', 'live-profile', 'slot-v2-18.json'))).size < 1_024 * 1_024)

    const popularity = JSON.parse(await readFile(join(outputDir, 'data', 'live-profile', 'popularity-v1-1.json'), 'utf8'))
    assert.equal(popularity.weekday, 1)
    assert.equal(popularity.profiles.length, manifest.matchKeys.length)
    assert.ok(popularity.profiles.some(day => Array.isArray(day) && day.length === 24 && day.some(Boolean)))
    assert.ok((await stat(join(outputDir, 'data', 'live-profile', 'popularity-v1-1.json'))).size < 1_024 * 1_024)

    const replayManifest = JSON.parse(await readFile(join(outputDir, 'data', 'replay', 'manifest.json'), 'utf8'))
    assert.equal(Object.keys(replayManifest.labels).length, 3)
    assert.equal(replayManifest.labels['2026-04-26T17:00:00+08:00'], '晚間雙向供需壓力')

    const replay = JSON.parse(await readFile(join(outputDir, 'data', 'replay', 'scenario-01-202604261700000800.json'), 'utf8'))
    const forecast = replay.stations[0]?.forecast?.horizons?.['60']
    assert.match(forecast.targetAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00\+08:00$/)
    assert.ok(['sufficient', 'limited', 'unmatched', 'not_applicable'].includes(forecast.baselineCoverage))
    const operations = new Set(replay.dispatches.map(dispatch => dispatch.operation))
    assert.ok(operations.has('deliver_bikes'))
    assert.ok(operations.has('remove_bikes'))
    for (const alert of replay.alerts) {
      assert.ok(Number.isFinite(alert.priorityScore) && alert.priorityScore >= 0 && alert.priorityScore <= 100)
      assert.deepEqual(Object.keys(alert.scoreParts).sort(), ['current', 'duration', 'forecast', 'gap', 'quality'])
      assert.equal(typeof alert.dispatchEligible, 'boolean')
      if (alert.condition === 'unavailable') {
        assert.equal(alert.priorityScore, 0)
        assert.equal(alert.dispatchEligible, false)
      }
    }
    for (const dispatch of replay.dispatches) {
      const alert = dispatch.alertId ? replay.alerts.find(candidate => candidate.id === dispatch.alertId) : null
      if (!alert) continue
      const expectedStationId = dispatch.operation === 'remove_bikes' ? dispatch.fromStationId : dispatch.toStationId
      assert.equal(alert.stationId, expectedStationId, `${dispatch.id} must link the affected side of the move`)
    }
  } finally {
    await rm(outputDir, { recursive: true, force: true })
  }
})
