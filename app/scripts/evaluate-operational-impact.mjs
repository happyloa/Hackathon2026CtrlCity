import { readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { LOW_INVENTORY_POLICY, SAFETY_STOCK_POLICY } from '../shared/parameters.mjs'

const APP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DASHBOARD_FILE = resolve(APP_DIR, 'data', 'dashboard.json')
const FORECAST_FILE = resolve(APP_DIR, 'data', 'forecast-evaluation.json')
const OUTPUT_FILE = resolve(APP_DIR, 'data', 'operational-impact.json')

function round(value, digits = 3) {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

function isInventoryIssue(station) {
  if (station.serviceStatus && station.serviceStatus !== 'operational') return false
  return station.availableBikes === 0 || station.availableDocks === 0
}

function simulateScenario(asOf, scenario) {
  const stations = new Map((scenario.stations || []).map(station => [station.id, {
    ...station,
    availableBikes: Math.max(0, Number(station.availableBikes) || 0),
    availableDocks: Math.max(0, Number(station.availableDocks) || 0),
  }]))
  const beforeIssueStations = [...stations.values()].filter(isInventoryIssue).length
  let assignedMoves = 0
  let bikesMoved = 0

  for (const dispatch of scenario.dispatches || []) {
    const from = stations.get(dispatch.sourceStationId)
    const to = stations.get(dispatch.destinationStationId)
    if (!from || !to || from.id === to.id) continue

    const donorSafetyStock = Math.max(SAFETY_STOCK_POLICY.minimum, Math.ceil((Number(from.totalDocks) || 0) * SAFETY_STOCK_POLICY.ratio))
    const receiverDockBuffer = Math.max(LOW_INVENTORY_POLICY.floor, Math.ceil((Number(to.totalDocks) || 0) * LOW_INVENTORY_POLICY.ratio))
    const requested = Math.max(0, Math.round(Number(dispatch.suggestedBikes) || 0))
    const movable = Math.max(0, Math.min(
      requested,
      from.availableBikes - donorSafetyStock,
      to.availableDocks - receiverDockBuffer,
    ))
    // Count only recommendations whose full requested quantity remains
    // feasible after earlier moves in the same counterfactual sequence.
    if (!requested || movable < requested) continue

    from.availableBikes -= movable
    from.availableDocks += movable
    to.availableBikes += movable
    to.availableDocks -= movable
    assignedMoves += 1
    bikesMoved += movable
  }

  const afterIssueStations = [...stations.values()].filter(isInventoryIssue).length
  const immediatelyAddressedStations = Math.max(0, beforeIssueStations - afterIssueStations)
  return {
    asOf,
    label: scenario.summary?.scenarioLabel || 'historical_scenario',
    beforeIssueStations,
    afterIssueStations,
    immediatelyAddressedStations,
    reductionRate: beforeIssueStations ? round(immediatelyAddressedStations / beforeIssueStations) : 0,
    proposedMoves: (scenario.dispatches || []).length,
    feasibleMoves: assignedMoves,
    bikesMoved,
  }
}

async function main() {
  const [dashboard, forecast] = await Promise.all([
    readFile(DASHBOARD_FILE, 'utf8').then(JSON.parse),
    readFile(FORECAST_FILE, 'utf8').then(JSON.parse),
  ])
  const horizons = Object.fromEntries(Object.entries(forecast.test.horizons).map(([minutes, result]) => {
    const inventory = result.inventoryIssue
    return [minutes, {
      leadTimeMinutes: Number(minutes),
      evaluatedSnapshots: inventory.predictionCount,
      issueSnapshots: inventory.tp + inventory.fn,
      correctlyFlaggedSnapshots: inventory.tp,
      precision: inventory.precision,
      recall: inventory.recall,
      f1: inventory.f1,
    }]
  }))
  const scenarios = Object.fromEntries(Object.entries(dashboard.scenarios || {}).map(([asOf, scenario]) => [
    asOf,
    simulateScenario(asOf, scenario),
  ]))

  const output = {
    schemaVersion: '1.0',
    generatedAt: new Date().toISOString(),
    evidencePolicy: {
      forecast: '2026 年 6 月保留測試集；每筆為可評估的站點半小時快照。',
      dispatch: '歷史情境的即時庫存反事實試算；依建議順序，只計入可完整執行建議量且保留來源站安全庫存與目的站空位緩衝的任務。',
      disclaimer: '這是離線決策支援證據，不代表已在真實車隊完成派遣或產生相同營運成效。',
    },
    forecastHoldout: {
      split: forecast.test.split,
      cohortStations: forecast.cohort.stationCount,
      horizons,
    },
    dispatchSimulation: { scenarios },
  }

  await writeFile(OUTPUT_FILE, `${JSON.stringify(output, null, 2)}\n`, 'utf8')
  console.log(`Wrote ${OUTPUT_FILE}`)
}

main().catch((error) => {
  console.error(error.stack || error.message)
  process.exitCode = 1
})
