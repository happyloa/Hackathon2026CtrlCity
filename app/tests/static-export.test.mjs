import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { exportReplayStatic } from '../scripts/export-replay-static.mjs'

test('static export preserves dual-direction dispatches and shards live profiles', async () => {
  const outputDir = await mkdtemp(join(tmpdir(), 'ctrlcity-static-export-'))
  try {
    const result = await exportReplayStatic(outputDir)
    assert.equal(result.scenarios, 3)
    assert.ok(result.liveProfiles.stations >= 1_500)

    const manifest = JSON.parse(await readFile(join(outputDir, 'data', 'live-profile', 'manifest.json'), 'utf8'))
    assert.equal(manifest.timezone, 'Asia/Taipei')
    assert.equal(Object.keys(manifest.slots).length, 48)
    assert.equal(manifest.riskPolicy.alertThresholds['60'], .45)

    const slot = JSON.parse(await readFile(join(outputDir, 'data', 'live-profile', 'slot-18.json'), 'utf8'))
    assert.equal(slot.slot, 18)
    assert.ok(Object.keys(slot.profiles).length >= 1_000)
    assert.ok((await stat(join(outputDir, 'data', 'live-profile', 'slot-18.json'))).size < 1_024 * 1_024)

    const replay = JSON.parse(await readFile(join(outputDir, 'data', 'replay', 'scenario-01-202604261700000800.json'), 'utf8'))
    const operations = new Set(replay.dispatches.map(dispatch => dispatch.operation))
    assert.ok(operations.has('deliver_bikes'))
    assert.ok(operations.has('remove_bikes'))
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
