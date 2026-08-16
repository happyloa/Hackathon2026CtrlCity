import { readFile, stat } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const DASHBOARD_FILE = resolve(SCRIPT_DIR, '..', 'data', 'dashboard.json')
const MAX_SIZE_BYTES = 16 * 1024 * 1024
const ISO_LOCAL_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00\+08:00$/
const STATE_VALUES = new Set(['normal', 'low_bikes', 'low_docks', 'empty', 'full', 'unavailable'])
const SEVERITY_VALUES = new Set(['normal', 'warning', 'critical'])
const SERVICE_STATUS_VALUES = new Set(['operational', 'official_inactive', 'suspected_unavailable'])
const CURRENT_MODEL_VERSION = 'historical-live-inventory-baseline-v2'

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value)
}

function assertAt(value, path) {
  assert(typeof value === 'string' && ISO_LOCAL_PATTERN.test(value), `${path} must be a +08:00 half-hour timestamp`)
}

function assertRisk(value, path) {
  assert(isFiniteNumber(value) && value >= 0 && value <= 1, `${path} must be a probability between 0 and 1`)
}

function validateStation(station, scenarioAt, history, requiresPredictionContract) {
  const base = `station ${station?.id ?? '<missing>'}`
  for (const field of [
    'id',
    'name',
    'district',
    'city',
    'totalDocks',
    'availableBikes',
    'availableDocks',
    'capacityGap',
    'currentState',
    'serviceStatus',
    'qualityFlags',
    'forecast',
  ]) {
    assert(Object.hasOwn(station, field), `${base} is missing ${field}`)
  }
  assert(typeof station.id === 'string' && station.id.startsWith('st_'), `${base} has an invalid id`)
  assert(typeof station.name === 'string' && station.name.length > 0, `${base} has an invalid name`)
  assert(isFiniteNumber(station.totalDocks) && station.totalDocks >= 0, `${base} has invalid totalDocks`)
  assert(isFiniteNumber(station.availableBikes) && station.availableBikes >= 0, `${base} has invalid availableBikes`)
  assert(isFiniteNumber(station.availableDocks) && station.availableDocks >= 0, `${base} has invalid availableDocks`)
  assert(station.latitude === null || isFiniteNumber(station.latitude), `${base} has invalid latitude`)
  assert(station.longitude === null || isFiniteNumber(station.longitude), `${base} has invalid longitude`)
  assert(STATE_VALUES.has(station.currentState), `${base} has an invalid currentState`)
  assert(SERVICE_STATUS_VALUES.has(station.serviceStatus), `${base} has an invalid serviceStatus`)
  assert(SEVERITY_VALUES.has(station.severity), `${base} has an invalid severity`)
  assert(Array.isArray(station.qualityFlags), `${base} has invalid qualityFlags`)

  if (station.currentState === 'unavailable') {
    assert(station.availableBikes === 0 && station.availableDocks === 0, `${base} unavailable state is inconsistent`)
  }
  if (station.currentState === 'empty') {
    assert(station.availableBikes === 0 && station.availableDocks > 0, `${base} empty state is inconsistent`)
  }
  if (station.currentState === 'full') {
    assert(station.availableDocks === 0 && station.availableBikes > 0, `${base} full state is inconsistent`)
  }

  for (const horizon of ['30', '60', '120']) {
    const forecast = station.forecast?.horizons?.[horizon]
    assert(forecast && typeof forecast === 'object', `${base} is missing ${horizon}-minute forecast`)
    assertAt(forecast.targetAt ?? forecast.at, `${base} ${horizon}-minute forecast.targetAt`)
    assertRisk(forecast.emptyRisk, `${base} ${horizon}-minute emptyRisk`)
    assertRisk(forecast.fullRisk, `${base} ${horizon}-minute fullRisk`)
    assertRisk(forecast.unavailableRisk, `${base} ${horizon}-minute unavailableRisk`)
    assert(isFiniteNumber(forecast.predictedBikes) && forecast.predictedBikes >= 0, `${base} has invalid predictedBikes`)
    assert(isFiniteNumber(forecast.predictedDocks) && forecast.predictedDocks >= 0, `${base} has invalid predictedDocks`)
    assertRisk(forecast.confidence, `${base} ${horizon}-minute confidence`)
    assertRisk(forecast.alertThreshold, `${base} ${horizon}-minute alertThreshold`)
    assert(Number.isInteger(forecast.sampleSize) && forecast.sampleSize >= 0, `${base} ${horizon}-minute sampleSize is invalid`)
    assert(['matched', 'unmatched', 'not_applicable'].includes(forecast.baselineStatus), `${base} ${horizon}-minute baselineStatus is invalid`)
    assert(['historical_replay', 'historical_baseline_live_inventory', 'inventory_only'].includes(forecast.method), `${base} ${horizon}-minute method is invalid`)
    if (requiresPredictionContract) {
      assertAt(forecast.targetAt, `${base} ${horizon}-minute forecast.targetAt`)
      assert(['sufficient', 'limited', 'unmatched', 'not_applicable'].includes(forecast.baselineCoverage), `${base} ${horizon}-minute baselineCoverage is invalid`)
      assert(forecast.baselineBikes === null || (isFiniteNumber(forecast.baselineBikes) && forecast.baselineBikes >= 0), `${base} ${horizon}-minute baselineBikes is invalid`)
      assert(forecast.baselineDocks === null || (isFiniteNumber(forecast.baselineDocks) && forecast.baselineDocks >= 0), `${base} ${horizon}-minute baselineDocks is invalid`)
    }
    assert(Array.isArray(forecast.reasons) && forecast.reasons.length > 0, `${base} ${horizon}-minute reasons are missing`)
  }

  assert(Array.isArray(history) && history.length > 0, `${base} has no history`)
  assert(history.at(-1).at === scenarioAt, `${base} history must end at its scenario time`)
  let previousAt = ''
  for (const point of history) {
    assertAt(point.at, `${base} history.at`)
    assert(point.at >= previousAt, `${base} history is not sorted`)
    assert(isFiniteNumber(point.bikes) && point.bikes >= 0, `${base} history has invalid bikes`)
    assert(isFiniteNumber(point.docks) && point.docks >= 0, `${base} history has invalid docks`)
    previousAt = point.at
  }
}

function validateScenario(at, scenario, requiresPredictionContract) {
  assertAt(at, `scenario ${at} key`)
  for (const field of ['summary', 'stations', 'alerts', 'dispatches', 'briefingFacts', 'stationHistories']) {
    assert(Object.hasOwn(scenario, field), `scenario ${at} is missing ${field}`)
  }
  assert(scenario.summary.at === at, `scenario ${at} summary.at differs from key`)
  assert(Array.isArray(scenario.stations) && scenario.stations.length > 0, `scenario ${at} has no stations`)
  assert(scenario.summary.totalStations === scenario.stations.length, `scenario ${at} station count does not reconcile`)
  assert(Array.isArray(scenario.alerts), `scenario ${at} alerts is not an array`)
  assert(Array.isArray(scenario.dispatches), `scenario ${at} dispatches is not an array`)
  assert(Array.isArray(scenario.briefingFacts) && scenario.briefingFacts.length >= 3, `scenario ${at} briefing facts are incomplete`)

  const stationIds = new Set()
  for (const station of scenario.stations) {
    assert(!stationIds.has(station.id), `scenario ${at} duplicates station ${station.id}`)
    stationIds.add(station.id)
    validateStation(station, at, scenario.stationHistories[station.id], requiresPredictionContract)
  }

  for (const alert of scenario.alerts) {
    const station = scenario.stations.find(candidate => candidate.id === alert.stationId)
    assert(station, `scenario ${at} alert references unknown station ${alert.stationId}`)
    assert(SEVERITY_VALUES.has(alert.severity), `scenario ${at} alert has invalid severity`)
    assertRisk(alert.risk, `scenario ${at} alert risk`)
    assertAt(alert.startedAt, `scenario ${at} alert ${alert.id} startedAt`)
    assert(Number.isInteger(alert.durationMinutes) && alert.durationMinutes >= 30 && alert.durationMinutes % 30 === 0, `scenario ${at} alert ${alert.id} has an invalid durationMinutes`)
    if (['empty', 'full', 'unavailable'].includes(station.currentState)) {
      assert(alert.type === station.currentState, `scenario ${at} alert ${alert.id} does not retain its current inventory condition`)
    }
  }
  for (const dispatch of scenario.dispatches) {
    assert(stationIds.has(dispatch.sourceStationId), `scenario ${at} dispatch source is missing`)
    assert(stationIds.has(dispatch.destinationStationId), `scenario ${at} dispatch destination is missing`)
    assert(dispatch.sourceStationId !== dispatch.destinationStationId, `scenario ${at} dispatch cannot loop to the same station`)
    assert(isFiniteNumber(dispatch.suggestedBikes) && dispatch.suggestedBikes > 0, `scenario ${at} dispatch has invalid bike count`)
    assert(dispatch.operation === 'deliver_bikes' || dispatch.operation === 'remove_bikes', `scenario ${at} dispatch has an invalid operation`)
  }
}

function validateLiveProfiles(liveProfiles, requiresPredictionContract) {
  assert(liveProfiles && typeof liveProfiles === 'object', 'liveProfiles is missing')
  assert(liveProfiles.schemaVersion === '1.0', 'liveProfiles schemaVersion is invalid')
  assert(liveProfiles.timezone === 'Asia/Taipei', 'liveProfiles timezone must be Asia/Taipei')
  assert(Array.isArray(liveProfiles.stations) && liveProfiles.stations.length > 1000, 'liveProfiles stations are incomplete')
  assert(liveProfiles.riskPolicy?.version, 'liveProfiles risk policy is missing')
  for (const horizon of ['30', '60', '120']) {
    assertRisk(liveProfiles.riskPolicy.alertThresholds?.[horizon], `liveProfiles ${horizon}-minute alert threshold`)
  }
  const ids = new Set()
  for (const station of liveProfiles.stations) {
    assert(typeof station.id === 'string' && station.id.startsWith('st_'), 'liveProfiles has an invalid station id')
    assert(!ids.has(station.id), `liveProfiles duplicates ${station.id}`)
    ids.add(station.id)
    assert(typeof station.matchKey === 'string' && station.matchKey.includes('|'), `liveProfiles ${station.id} has invalid matchKey`)
    assert(Array.isArray(station.slots) && station.slots.length === 48, `liveProfiles ${station.id} must have 48 slots`)
    for (const profile of station.slots) {
      if (profile === null) continue
      assert(Array.isArray(profile) && profile.length === 6, `liveProfiles ${station.id} has invalid compact profile`)
      assert(profile.every((value) => Number.isInteger(value) && value >= 0), `liveProfiles ${station.id} has non-integer profile values`)
      assert(profile.slice(3).every((value) => value <= 1000), `liveProfiles ${station.id} has invalid permille risk`)
    }
  }
  if (requiresPredictionContract) {
    const prediction = liveProfiles.prediction
    assert(prediction?.schemaVersion === '1.0', 'liveProfiles prediction schemaVersion is invalid')
    assert(prediction.primaryHorizonMinutes === 60, 'liveProfiles prediction primary horizon must be 60 minutes')
    assert(prediction.objective === 'station_empty_or_full_inventory_risk', 'liveProfiles prediction objective is invalid')
    assert(prediction.method === 'historical_station_slot_baseline_plus_live_inventory', 'liveProfiles prediction method is invalid')
    assert(Array.isArray(prediction.inputPolicy) && prediction.inputPolicy.join('|') === 'historical_station_slot_profile|current_live_inventory|page_session_momentum_optional', 'liveProfiles prediction inputs are invalid')
    assert(prediction.confidencePolicy?.limitedMaxSampleSize === 5, 'liveProfiles prediction limited sample threshold is invalid')
    assert(prediction.confidencePolicy?.sufficientMinSampleSize === 6, 'liveProfiles prediction sufficient sample threshold is invalid')
    assert(prediction.confidencePolicy?.highConfidenceMinSampleSize === 12, 'liveProfiles prediction high-confidence threshold is invalid')
    assert(prediction.coverage?.historicalProfileStations === liveProfiles.stations.length, 'liveProfiles prediction station coverage is invalid')
    assert(prediction.coverage?.populatedStationSlots > 0, 'liveProfiles prediction slot coverage is invalid')
  }
}

async function main() {
  const fileStats = await stat(DASHBOARD_FILE)
  assert(fileStats.size <= MAX_SIZE_BYTES, `dashboard.json is ${(fileStats.size / 1024 / 1024).toFixed(2)} MiB; limit is 12 MiB`)

  const dashboard = JSON.parse(await readFile(DASHBOARD_FILE, 'utf8'))
  for (const field of [
    'meta',
    'districts',
    'liveProfiles',
    'scenarios',
  ]) {
    assert(Object.hasOwn(dashboard, field), `dashboard is missing top-level ${field}`)
  }

  assertAt(dashboard.meta.asOf, 'meta.asOf')
  assert(typeof dashboard.meta.generatedAt === 'string' && !Number.isNaN(Date.parse(dashboard.meta.generatedAt)), 'meta.generatedAt is invalid')
  assert(dashboard.meta.dataMode === 'historical_replay', 'meta.dataMode must be historical_replay')
  assert(typeof dashboard.meta.modelVersion === 'string' && dashboard.meta.modelVersion.length > 0, 'meta.modelVersion is missing')
  const requiresPredictionContract = dashboard.meta.modelVersion === CURRENT_MODEL_VERSION
  assert(dashboard.meta.riskPolicy?.version, 'meta.riskPolicy is missing')
  for (const horizon of ['30', '60', '120']) {
    assertRisk(dashboard.meta.riskPolicy.alertThresholds?.[horizon], `meta.riskPolicy ${horizon}-minute threshold`)
  }
  assert(dashboard.meta.coverage?.rawRows > 1_000_000, 'coverage.rawRows is unexpectedly small')
  assert(dashboard.meta.coverage?.validRows > 1_000_000, 'coverage.validRows is unexpectedly small')
  assert(dashboard.meta.coverage?.availableTimeCount > 1_000, 'coverage.availableTimeCount is unexpectedly small')
  assertAt(dashboard.meta.coverage?.firstAt, 'coverage.firstAt')
  assertAt(dashboard.meta.coverage?.lastAt, 'coverage.lastAt')
  assert(dashboard.meta.coverage.firstAt < dashboard.meta.coverage.lastAt, 'coverage time range is invalid')
  assert(dashboard.meta.quality?.unavailableRowsExcludedFromProfile > 0, 'unavailable rows were not recorded as excluded')

  const scenarioEntries = Object.entries(dashboard.scenarios)
  assert(scenarioEntries.length >= 3 && scenarioEntries.length <= 6, 'dashboard must contain 3 to 6 replay scenarios')
  for (const [at, scenario] of scenarioEntries) {
    validateScenario(at, scenario, requiresPredictionContract)
  }

  const defaultScenario = dashboard.scenarios[dashboard.meta.asOf]
  assert(defaultScenario, 'default meta.asOf scenario is missing')
  validateLiveProfiles(dashboard.liveProfiles, requiresPredictionContract)

  console.log(`Artifact validation passed: ${(fileStats.size / 1024 / 1024).toFixed(2)} MiB, ${dashboard.meta.coverage.availableTimeCount} time slots, ${scenarioEntries.length} scenarios, ${defaultScenario.stations.length} default stations.`)
}

main().catch((error) => {
  console.error(`Artifact validation failed: ${error.message}`)
  process.exitCode = 1
})
