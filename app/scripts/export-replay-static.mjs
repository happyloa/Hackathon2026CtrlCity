import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const APP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SOURCE_FILE = resolve(APP_DIR, 'server', 'data', 'dashboard.json')

function record(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

function list(value) {
  return Array.isArray(value) ? value : []
}

function text(value, fallback = '') {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback
}

function number(value, fallback = 0) {
  const candidate = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(candidate) ? candidate : fallback
}

function clamp(value, min = 0, max = 1) {
  return Math.min(max, Math.max(min, value))
}

function round(value, decimals = 3) {
  const multiplier = 10 ** decimals
  return Math.round(value * multiplier) / multiplier
}

function currentState(value) {
  if (value === 'empty' || value === 'empty_now') return 'empty_now'
  if (value === 'full' || value === 'full_now') return 'full_now'
  if (value === 'unavailable') return 'unavailable'
  return 'normal'
}

function riskLevel(score) {
  if (score >= 0.75) return 'critical'
  if (score >= 0.5) return 'high'
  if (score >= 0.25) return 'medium'
  return 'normal'
}

function confidence(value) {
  const score = clamp(number(value, 0.5))
  return score >= 0.65 ? 'high' : score >= 0.35 ? 'medium' : 'low'
}

function normalizeStation(raw) {
  const source = record(raw)
  const availableBikes = Math.max(0, Math.round(number(source.availableBikes)))
  const availableDocks = Math.max(0, Math.round(number(source.availableDocks)))
  const rawHorizons = record(record(source.forecast).horizons)
  const horizons = {}

  for (const horizon of ['30', '60', '120']) {
    const forecast = record(rawHorizons[horizon])
    const emptyRisk = clamp(number(forecast.emptyRisk))
    const fullRisk = clamp(number(forecast.fullRisk))
    const unavailableRisk = clamp(number(forecast.unavailableRisk))
    const score = round(Math.max(emptyRisk, fullRisk, unavailableRisk))
    horizons[horizon] = {
      predictedBikes: Math.max(0, Math.round(number(forecast.predictedBikes, availableBikes))),
      predictedDocks: Math.max(0, Math.round(number(forecast.predictedDocks, availableDocks))),
      emptyRisk,
      fullRisk,
      riskScore: score,
      level: riskLevel(score),
      confidence: confidence(forecast.confidence),
      reasons: list(forecast.reasons).map((reason) => text(reason)).filter(Boolean),
    }
  }

  const latitude = number(source.latitude, Number.NaN)
  const longitude = number(source.longitude, Number.NaN)
  return {
    id: text(source.id),
    name: text(source.name, '未命名站點'),
    city: text(source.city, '新北市'),
    district: text(source.district, '未分類'),
    latitude: Number.isFinite(latitude) ? latitude : null,
    longitude: Number.isFinite(longitude) ? longitude : null,
    totalDocks: Math.max(0, Math.round(number(source.totalDocks))),
    availableBikes,
    availableDocks,
    capacityGap: Math.round(number(source.capacityGap)),
    currentState: currentState(source.currentState),
    qualityFlags: list(source.qualityFlags).map((flag) => text(flag)).filter(Boolean),
    forecast: { horizons },
  }
}

function alertCondition(raw, station) {
  const source = record(raw)
  const type = text(source.type)
  const state = station ? station.currentState : currentState(source.currentState)
  if (type === 'unavailable' || state === 'unavailable') return 'unavailable'
  if (type === 'full') return state === 'full_now' ? 'full_now' : 'full_forecast'
  return state === 'empty_now' ? 'empty_now' : 'empty_forecast'
}

function normalizeAlert(raw, stations, asOf) {
  const source = record(raw)
  const stationId = text(source.stationId)
  const station = stations.get(stationId)
  const forecast = station ? station.forecast.horizons['60'] : undefined
  const score = clamp(number(source.risk, forecast ? forecast.riskScore : 0))
  const severity = text(source.severity)
  const condition = alertCondition(source, station)
  const duration = Math.max(1, Math.round(number(source.durationMinutes, condition.endsWith('_now') ? 30 : 60)))
  const message = text(source.message)

  return {
    id: text(source.id, 'alert_' + stationId),
    stationId,
    condition,
    severity: severity === 'critical' || score >= 0.75 ? 'critical' : severity === 'high' || severity === 'warning' || score >= 0.5 ? 'high' : 'medium',
    startedAt: text(source.startedAt, asOf),
    durationMinutes: duration,
    riskScore: score,
    status: 'open',
    reasons: message ? [message] : ['此站在回放時點呈現持續服務風險。'],
  }
}

function normalizeDispatch(raw, alerts) {
  const source = record(raw)
  const fromStationId = text(source.sourceStationId)
  const toStationId = text(source.destinationStationId)
  const id = text(source.id, 'dispatch_' + fromStationId + '_' + toStationId)
  const linkedAlert = alerts.find((alert) => alert.stationId === toStationId && alert.condition !== 'full_now')
  const priority = text(source.priority)
  const rationale = text(source.rationale)

  return {
    id,
    alertId: linkedAlert ? linkedAlert.id : null,
    operation: 'deliver_bikes',
    fromStationId,
    toStationId,
    bikeCount: Math.max(1, Math.round(number(source.suggestedBikes, 1))),
    distanceKm: Math.max(0, round(number(source.distanceKm), 2)),
    priorityScore: priority === 'high' ? 90 : priority === 'medium' ? 65 : 45,
    reasons: rationale ? [rationale] : ['依據站點庫存與距離提供人工覆核用的調度建議。'],
    status: 'proposed',
    requiresOperatorReview: true,
  }
}

function briefingFacts(rawFacts, summary, alerts, dispatches) {
  const facts = list(rawFacts)
    .map((fact, index) => {
      if (typeof fact === 'string') return { label: '風險重點 ' + (index + 1), value: fact }
      const source = record(fact)
      const label = text(source.label)
      const value = source.value
      return label && (typeof value === 'string' || typeof value === 'number')
        ? { label, value }
        : null
    })
    .filter(Boolean)

  if (facts.length) return facts
  return [
    { label: '60 分鐘高風險站', value: summary.highRiskNext60m },
    { label: '待處理告警', value: alerts.length },
    { label: '待人工覆核調度', value: dispatches.length },
  ]
}

function makeMeta(source, availableTimes, asOf, stationCount) {
  const rawMeta = record(source.meta)
  const coverage = record(rawMeta.coverage)
  const quality = record(rawMeta.quality)
  const sourceRows = Math.max(0, Math.round(number(coverage.validRows, number(coverage.sourceRows))))
  const unavailableRows = Math.max(0, number(quality.unavailableRowsExcludedFromProfile))
  const flagCounts = record(quality.flagCounts)
  const capacityGapRows = Math.max(0, number(flagCounts.capacity_gap))

  return {
    asOf,
    generatedAt: text(rawMeta.generatedAt, new Date(0).toISOString()),
    dataMode: 'historical_replay',
    modelVersion: text(rawMeta.modelVersion, 'historical-profile-heuristic-v1'),
    coverage: {
      sourceRows,
      sourceFiles: Math.max(0, Math.round(number(coverage.sourceFiles))),
      stationCount,
      dateRange: {
        from: text(coverage.firstAt, availableTimes[0] || ''),
        to: text(coverage.lastAt, availableTimes.at(-1) || ''),
      },
    },
    quality: {
      unavailableRate: sourceRows ? round(unavailableRows / sourceRows) : 0,
      capacityMismatchRate: sourceRows ? round(capacityGapRows / sourceRows) : 0,
      notes: [
        '歷史資料中的服務不可用觀測會保留為品質旗標，且不會被誤判為無車或無位。',
        ...(text(rawMeta.forecastMethod) ? [text(rawMeta.forecastMethod)] : []),
      ],
    },
  }
}

function makeDashboard(source, asOf, scenario, availableTimes, districts) {
  const stations = list(record(scenario).stations).map(normalizeStation).filter((station) => station.id)
  const stationMap = new Map(stations.map((station) => [station.id, station]))
  const alerts = list(record(scenario).alerts).map((alert) => normalizeAlert(alert, stationMap, asOf))
  const dispatches = list(record(scenario).dispatches).map((dispatch) => normalizeDispatch(dispatch, alerts))
  const rawHistories = record(record(scenario).stationHistories)
  const stationHistories = Object.fromEntries(stations.map((station) => [
    station.id,
    list(rawHistories[station.id])
      .map((point) => {
        const sourcePoint = record(point)
        return {
          at: text(sourcePoint.at),
          bikes: Math.max(0, Math.round(number(sourcePoint.bikes))),
          docks: Math.max(0, Math.round(number(sourcePoint.docks))),
        }
      })
      .filter((point) => point.at)
      .sort((left, right) => Date.parse(left.at) - Date.parse(right.at)),
  ]))
  const summary = {
    totalStations: stations.length,
    emptyNow: stations.filter((station) => station.currentState === 'empty_now').length,
    fullNow: stations.filter((station) => station.currentState === 'full_now').length,
    unavailableNow: stations.filter((station) => station.currentState === 'unavailable').length,
    highRiskNext60m: stations.filter((station) => {
      const forecast = station.forecast.horizons['60']
      return forecast.level === 'high' || forecast.level === 'critical'
    }).length,
    persistentAlerts: alerts.length,
    recommendedMoves: dispatches.length,
  }

  return {
    meta: makeMeta(source, availableTimes, asOf, stations.length),
    availableTimes,
    districts,
    summary,
    stations,
    alerts,
    dispatches,
    briefingFacts: briefingFacts(record(scenario).briefingFacts, summary, alerts, dispatches),
    stationHistories,
  }
}

function fileName(asOf, index) {
  return 'scenario-' + String(index + 1).padStart(2, '0') + '-' + asOf.replace(/[^0-9]/g, '') + '.json'
}

export async function exportReplayStatic(outputDir) {
  const source = JSON.parse(await readFile(SOURCE_FILE, 'utf8'))
  const scenarios = record(source.scenarios)
  const keys = Object.keys(scenarios).sort((left, right) => Date.parse(left) - Date.parse(right))
  const availableTimes = keys
  const defaultAsOf = text(record(source.meta).asOf, keys.at(-1) || '')
  const replayDir = resolve(outputDir, 'data', 'replay')

  await rm(replayDir, { recursive: true, force: true })
  await mkdir(replayDir, { recursive: true })

  const scenarioPaths = {}
  for (const [index, asOf] of keys.entries()) {
    const name = fileName(asOf, index)
    scenarioPaths[asOf] = '/data/replay/' + name
    const dashboard = makeDashboard(source, asOf, scenarios[asOf], availableTimes, list(source.districts).map((value) => text(value)).filter(Boolean))
    await writeFile(resolve(replayDir, name), JSON.stringify(dashboard), 'utf8')
  }

  const manifest = {
    version: 1,
    defaultAsOf: scenarioPaths[defaultAsOf] ? defaultAsOf : keys.at(-1) || '',
    availableTimes,
    districts: list(source.districts).map((value) => text(value)).filter(Boolean),
    scenarios: scenarioPaths,
  }
  await writeFile(resolve(replayDir, 'manifest.json'), JSON.stringify(manifest), 'utf8')

  return {
    scenarios: keys.length,
    defaultAsOf: manifest.defaultAsOf,
    output: replayDir,
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const outputDir = resolve(APP_DIR, 'dist')
  const result = await exportReplayStatic(outputDir)
  console.log('Exported ' + result.scenarios + ' static replay scenarios to ' + result.output)
}
