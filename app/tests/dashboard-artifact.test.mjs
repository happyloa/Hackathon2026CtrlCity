import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const artifactUrl = new URL('../server/data/dashboard.json', import.meta.url)
const dashboard = JSON.parse(await readFile(artifactUrl, 'utf8'))

const HORIZONS = ['30', '60', '120']
const RISK_FIELDS = ['emptyRisk', 'fullRisk', 'unavailableRisk', 'confidence']
const MIN_EXPECTED_STATIONS = 1_500
const HALF_HOUR_MS = 30 * 60 * 1000
const PERSISTENT_STATES = new Set(['empty', 'full', 'unavailable'])

function assertProbability(value, label) {
  assert.equal(typeof value, 'number', `${label} must be numeric`)
  assert.ok(Number.isFinite(value), `${label} must be finite`)
  assert.ok(value >= 0 && value <= 1, `${label} must be between 0 and 1`)
}

function scenarioEntries() {
  assert.ok(dashboard.scenarios && typeof dashboard.scenarios === 'object', 'dashboard.scenarios is required')
  return Object.entries(dashboard.scenarios)
}

function inventoryState(point) {
  if (point.bikes === 0 && point.docks === 0) return 'unavailable'
  if (point.bikes === 0 && point.docks > 0) return 'empty'
  if (point.bikes > 0 && point.docks === 0) return 'full'
  return 'normal'
}

function expectedPersistence(station, history, scenarioAt) {
  if (!PERSISTENT_STATES.has(station.currentState)) return null

  const snapshots = new Map(history.map(point => [Date.parse(point.at), point]))
  const scenarioEpoch = Date.parse(scenarioAt)
  let startedAt = scenarioAt
  let durationMinutes = 0

  for (let epoch = scenarioEpoch; ; epoch -= HALF_HOUR_MS) {
    const point = snapshots.get(epoch)
    if (!point || inventoryState(point) !== station.currentState) break
    startedAt = point.at
    durationMinutes += 30
  }

  return { startedAt, durationMinutes }
}

test('dashboard artifact contains the three selected historical replay scenarios', () => {
  assert.equal(dashboard.meta?.dataMode, 'historical_replay')
  assert.ok(Array.isArray(dashboard.availableTimes), 'availableTimes must be an array')

  const scenarios = scenarioEntries()
  assert.equal(scenarios.length, 3, 'the demo artifact must expose exactly three replay scenarios')

  for (const [at, scenario] of scenarios) {
    assert.ok(dashboard.availableTimes.includes(at), `scenario ${at} must be selectable`)
    assert.equal(scenario.summary?.at, at, `scenario ${at} summary must use its key time`)
    assert.ok(Array.isArray(scenario.stations), `scenario ${at} must contain stations`)
    assert.equal(scenario.summary.totalStations, scenario.stations.length, `scenario ${at} station total must reconcile`)
  }

  assert.ok(dashboard.scenarios[dashboard.meta.asOf], 'meta.asOf must identify the default scenario')
})

test('every replay scenario has a coherent station inventory and bounded forecast risks', () => {
  for (const [at, scenario] of scenarioEntries()) {
    assert.ok(scenario.stations.length >= MIN_EXPECTED_STATIONS, `scenario ${at} station coverage is unexpectedly low`)

    const stationIds = new Set()
    for (const station of scenario.stations) {
      assert.equal(typeof station.id, 'string', `scenario ${at} station id must be a string`)
      assert.ok(station.id.length > 0, `scenario ${at} station id cannot be empty`)
      assert.ok(!stationIds.has(station.id), `scenario ${at} cannot duplicate station ${station.id}`)
      stationIds.add(station.id)

      assert.ok(Number.isFinite(station.availableBikes) && station.availableBikes >= 0, `station ${station.id} has invalid availableBikes`)
      assert.ok(Number.isFinite(station.availableDocks) && station.availableDocks >= 0, `station ${station.id} has invalid availableDocks`)
      assert.ok(Number.isFinite(station.totalDocks) && station.totalDocks >= 0, `station ${station.id} has invalid totalDocks`)

      for (const horizon of HORIZONS) {
        const forecast = station.forecast?.horizons?.[horizon]
        assert.ok(forecast, `station ${station.id} is missing ${horizon}-minute forecast`)
        for (const field of RISK_FIELDS) {
          assertProbability(forecast[field], `station ${station.id} ${horizon}-minute ${field}`)
        }
        assert.ok(Number.isFinite(forecast.predictedBikes) && forecast.predictedBikes >= 0, `station ${station.id} ${horizon}-minute predictedBikes is invalid`)
        assert.ok(Number.isFinite(forecast.predictedDocks) && forecast.predictedDocks >= 0, `station ${station.id} ${horizon}-minute predictedDocks is invalid`)
      }
    }

    assert.ok(dashboard.meta.coverage.stationIdentities >= stationIds.size, `scenario ${at} exceeds recorded station coverage`)
  }
})

test('alerts and dispatches only reference stations present in their scenario', () => {
  for (const [at, scenario] of scenarioEntries()) {
    const stationById = new Map(scenario.stations.map((station) => [station.id, station]))
    const stationIds = new Set(stationById.keys())
    const alertIds = new Set()

    for (const alert of scenario.alerts) {
      assert.equal(typeof alert.id, 'string', `scenario ${at} alert id must be a string`)
      assert.ok(!alertIds.has(alert.id), `scenario ${at} cannot duplicate alert ${alert.id}`)
      alertIds.add(alert.id)
      assert.ok(stationIds.has(alert.stationId), `scenario ${at} alert ${alert.id} references an unknown station`)
      assertProbability(alert.risk, `scenario ${at} alert ${alert.id} risk`)
      assert.equal(typeof alert.startedAt, 'string', `scenario ${at} alert ${alert.id} must have a start time`)
      assert.ok(!Number.isNaN(Date.parse(alert.startedAt)), `scenario ${at} alert ${alert.id} has an invalid start time`)
      assert.ok(Number.isInteger(alert.durationMinutes) && alert.durationMinutes >= 30, `scenario ${at} alert ${alert.id} must have a non-zero bucket duration`)

      const station = stationById.get(alert.stationId)
      const persistence = expectedPersistence(station, scenario.stationHistories[station.id], at)
      if (persistence) {
        assert.equal(alert.type, station.currentState, `scenario ${at} alert ${alert.id} must retain its current inventory condition`)
        assert.equal(alert.startedAt, persistence.startedAt, `scenario ${at} alert ${alert.id} must start at the first contiguous bucket`)
        assert.equal(alert.durationMinutes, persistence.durationMinutes, `scenario ${at} alert ${alert.id} must include every contiguous bucket`)
      }
    }

    for (const dispatch of scenario.dispatches) {
      assert.ok(stationIds.has(dispatch.sourceStationId), `scenario ${at} dispatch ${dispatch.id} references an unknown source station`)
      assert.ok(stationIds.has(dispatch.destinationStationId), `scenario ${at} dispatch ${dispatch.id} references an unknown destination station`)
      assert.notEqual(dispatch.sourceStationId, dispatch.destinationStationId, `scenario ${at} dispatch ${dispatch.id} cannot use the same source and destination`)
      assert.ok(Number.isFinite(dispatch.suggestedBikes) && dispatch.suggestedBikes > 0, `scenario ${at} dispatch ${dispatch.id} must move at least one bike`)

      if (dispatch.alertId != null) {
        assert.ok(alertIds.has(dispatch.alertId), `scenario ${at} dispatch ${dispatch.id} references an unknown alert`)
      }
    }
  }
})
