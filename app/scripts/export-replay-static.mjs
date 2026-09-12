import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  RISK_POLICY_VERSION,
  alertThresholdFor,
  riskLevelFor,
} from './risk-policy.mjs'
import {
  DEFAULT_LIVE_OPERATION_POLICY,
  alertDataQuality,
  safetyStockFor,
  scoreAlertPriority,
} from '../shared/operational-policy.mjs'

const APP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SOURCE_FILE = resolve(APP_DIR, 'data', 'dashboard.json')

function record(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

function list(value) {
  return Array.isArray(value) ? value : []
}

function text(value, fallback = '') {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback
}

function modelVersion(value) {
  const version = text(value)
  return !version || version === 'historical-profile-heuristic-v1'
    ? 'historical-live-inventory-baseline-v2'
    : version
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

function confidence(value) {
  const score = clamp(number(value, 0.5))
  return score >= 0.65 ? 'high' : score >= 0.35 ? 'medium' : 'low'
}

function confidenceForSampleSize(sampleSize) {
  if (sampleSize >= 12) return 'high'
  if (sampleSize >= 6) return 'medium'
  return 'low'
}

function serviceStatus(value, state) {
  const status = text(value)
  if (status === 'official_inactive') return 'official_inactive'
  if (status === 'suspected_unavailable') return 'suspected_unavailable'
  return state === 'unavailable' ? 'suspected_unavailable' : 'operational'
}

function forecastMethod(value, fallback) {
  const method = text(value)
  if (method === 'live_historical_baseline') return 'historical_baseline_live_inventory'
  return method === 'historical_replay' || method === 'historical_baseline_live_inventory' || method === 'inventory_only'
    ? method
    : fallback
}

function baselineStatus(value, fallback) {
  const status = text(value)
  return status === 'matched' || status === 'unmatched' || status === 'not_applicable'
    ? status
    : fallback
}

function baselineCoverage(value, sampleSize, status) {
  const coverage = text(value)
  if (coverage === 'sufficient' || coverage === 'limited' || coverage === 'unmatched' || coverage === 'not_applicable') {
    return coverage
  }
  if (status !== 'matched') return status
  return sampleSize >= 6 ? 'sufficient' : 'limited'
}

function predictionMetadata(raw, stations) {
  const source = record(raw)
  const confidencePolicy = record(source.confidencePolicy)
  const coverage = record(source.coverage)
  const populatedStationSlots = stations.reduce(
    (total, station) => total + station.slots.filter(Boolean).length,
    0,
  )

  return {
    schemaVersion: '1.0',
    primaryHorizonMinutes: 60,
    objective: 'station_empty_or_full_inventory_risk',
    method: 'historical_station_slot_baseline_plus_live_inventory',
    inputPolicy: ['historical_station_slot_profile', 'current_live_inventory', 'page_session_momentum_optional'],
    confidencePolicy: {
      limitedMaxSampleSize: Math.max(0, Math.round(number(confidencePolicy.limitedMaxSampleSize, 5))),
      sufficientMinSampleSize: Math.max(1, Math.round(number(confidencePolicy.sufficientMinSampleSize, 6))),
      highConfidenceMinSampleSize: Math.max(1, Math.round(number(confidencePolicy.highConfidenceMinSampleSize, 12))),
    },
    coverage: {
      historicalProfileStations: Math.max(0, Math.round(number(coverage.historicalProfileStations, stations.length))),
      populatedStationSlots: Math.max(0, Math.round(number(coverage.populatedStationSlots, populatedStationSlots))),
    },
  }
}

function normalizeStation(raw, asOf) {
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
    const score = round(Math.max(emptyRisk, fullRisk))
    const alertThreshold = clamp(number(forecast.alertThreshold, alertThresholdFor(horizon)))
    const sampleSize = Math.max(0, Math.round(number(forecast.sampleSize)))
    const normalizedBaselineStatus = baselineStatus(forecast.baselineStatus, 'matched')
    const baselineBikes = number(forecast.baselineBikes, Number.NaN)
    const baselineDocks = number(forecast.baselineDocks, Number.NaN)
    horizons[horizon] = {
      targetAt: text(forecast.targetAt, text(forecast.at, asOf)),
      baselineBikes: Number.isFinite(baselineBikes) ? Math.max(0, Math.round(baselineBikes)) : null,
      baselineDocks: Number.isFinite(baselineDocks) ? Math.max(0, Math.round(baselineDocks)) : null,
      predictedBikes: Math.max(0, Math.round(number(forecast.predictedBikes, availableBikes))),
      predictedDocks: Math.max(0, Math.round(number(forecast.predictedDocks, availableDocks))),
      emptyRisk,
      fullRisk,
      unavailableRisk,
      riskScore: score,
      level: riskLevelFor(score, horizon),
      confidence: sampleSize ? confidenceForSampleSize(sampleSize) : confidence(forecast.confidence),
      alertThreshold,
      baselineStatus: normalizedBaselineStatus,
      baselineCoverage: baselineCoverage(forecast.baselineCoverage, sampleSize, normalizedBaselineStatus),
      method: forecastMethod(forecast.method, 'historical_replay'),
      sampleSize,
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
    serviceStatus: serviceStatus(source.serviceStatus, currentState(source.currentState)),
    qualityFlags: list(source.qualityFlags).map((flag) => text(flag)).filter(Boolean),
    forecast: { horizons },
  }
}

function alertCondition(raw, station) {
  const source = record(raw)
  const type = text(source.type)
  const state = station ? station.currentState : currentState(source.currentState)
  if (type === 'unavailable' || station?.serviceStatus !== 'operational' || state === 'unavailable') return 'unavailable'
  if (type === 'full') return state === 'full_now' ? 'full_now' : 'full_forecast'
  return state === 'empty_now' ? 'empty_now' : 'empty_forecast'
}

function normalizeAlert(raw, stations, asOf) {
  const source = record(raw)
  const stationId = text(source.stationId)
  const station = stations.get(stationId)
  const forecast = station ? station.forecast.horizons['60'] : undefined
  const condition = alertCondition(source, station)
  const fallbackScore = condition === 'unavailable'
    ? forecast ? forecast.unavailableRisk : 0
    : forecast ? forecast.riskScore : 0
  const score = clamp(number(source.risk, fallbackScore))
  const severity = text(source.severity)
  const duration = Math.max(1, Math.round(number(source.durationMinutes, condition.endsWith('_now') ? 30 : 60)))
  const message = text(source.message)
  const currentFailure = condition === 'empty_now' || condition === 'full_now'
  const inventory = condition === 'empty_now'
    ? station?.availableBikes ?? 0
    : condition === 'full_now'
      ? station?.availableDocks ?? 0
      : condition === 'empty_forecast'
        ? forecast?.predictedBikes ?? 0
        : forecast?.predictedDocks ?? 0
  const gap = station && condition !== 'unavailable'
    ? Math.max(0, Math.ceil(safetyStockFor(station) - inventory))
    : 0
  const priority = station && forecast && condition !== 'unavailable'
    ? scoreAlertPriority({
        riskScore: score,
        currentFailure,
        gap,
        quality: alertDataQuality(station, forecast),
      })
    : { priorityScore: 0, scoreParts: { duration: 0, forecast: 0, current: 0, gap: 0, quality: 0 } }

  return {
    id: text(source.id, 'alert_' + stationId),
    stationId,
    condition,
    severity: condition === 'unavailable' || severity === 'critical'
      ? 'critical'
      : severity === 'high' || severity === 'warning' || riskLevelFor(score, '60') === 'high'
        ? 'high'
        : 'medium',
    startedAt: text(source.startedAt, asOf),
    durationMinutes: duration,
    riskScore: score,
    ...priority,
    dispatchEligible: condition !== 'unavailable' && gap >= DEFAULT_LIVE_OPERATION_POLICY.minimumTransferBikes,
    status: 'open',
    reasons: message ? [message] : [condition === 'unavailable'
      ? '此站呈現疑似服務異常，不納入搬運路線。'
      : '此站在回放時點呈現持續庫存風險。'],
  }
}

function normalizeDispatch(raw, alerts) {
  const source = record(raw)
  const fromStationId = text(source.sourceStationId)
  const toStationId = text(source.destinationStationId)
  const operation = text(source.operation) === 'remove_bikes' ? 'remove_bikes' : 'deliver_bikes'
  const id = text(source.id, 'dispatch_' + fromStationId + '_' + toStationId)
  const alertStationId = operation === 'remove_bikes' ? fromStationId : toStationId
  const linkedAlert = alerts.find((alert) => alert.stationId === alertStationId && (
    operation === 'remove_bikes'
      ? alert.condition === 'full_now' || alert.condition === 'full_forecast'
      : alert.condition === 'empty_now' || alert.condition === 'empty_forecast'
  ))
  const priority = text(source.priority)
  const rationale = text(source.rationale)

  return {
    id,
    alertId: linkedAlert ? linkedAlert.id : null,
    operation,
    fromStationId,
    toStationId,
    bikeCount: Math.max(1, Math.round(number(source.suggestedBikes, 1))),
    distanceKm: Math.max(0, round(number(source.distanceKm), 2)),
    priorityScore: Math.max(0, Math.min(100, number(source.priorityScore, priority === 'high' ? 90 : priority === 'medium' ? 65 : 45))),
    reasons: rationale ? [rationale] : [operation === 'remove_bikes'
      ? '依滿站風險、可還位與距離提出移車建議。'
      : '依缺車風險、可借車與距離提出補車建議。'],
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
    { label: '搬運建議', value: dispatches.length },
  ]
}

function makeMeta(source, availableTimes, asOf, stationCount) {
  const rawMeta = record(source.meta)
  const coverage = record(rawMeta.coverage)
  const quality = record(rawMeta.quality)
  const rawRiskPolicy = record(rawMeta.riskPolicy)
  const rawThresholds = record(rawRiskPolicy.alertThresholds)
  const sourceRows = Math.max(0, Math.round(number(coverage.validRows, number(coverage.sourceRows))))
  const unavailableRows = Math.max(0, number(quality.unavailableRowsExcludedFromProfile))
  const flagCounts = record(quality.flagCounts)
  const capacityGapRows = Math.max(0, number(flagCounts.capacity_gap))

  return {
    asOf,
    generatedAt: text(rawMeta.generatedAt, new Date(0).toISOString()),
    dataMode: 'historical_replay',
    modelVersion: modelVersion(rawMeta.modelVersion),
    coverage: {
      sourceRows,
      sourceFiles: Math.max(0, Math.round(number(coverage.sourceFiles))),
      stationCount,
      dateRange: {
        from: text(coverage.firstAt, availableTimes[0] || ''),
        to: text(coverage.lastAt, availableTimes.at(-1) || ''),
      },
    },
    riskPolicy: {
      version: text(rawRiskPolicy.version, RISK_POLICY_VERSION),
      alertThresholds: {
        '30': clamp(number(rawThresholds['30'], alertThresholdFor('30'))),
        '60': clamp(number(rawThresholds['60'], alertThresholdFor('60'))),
        '120': clamp(number(rawThresholds['120'], alertThresholdFor('120'))),
      },
    },
    quality: {
      unavailableRate: sourceRows ? round(unavailableRows / sourceRows) : 0,
      capacityMismatchRate: sourceRows ? round(capacityGapRows / sourceRows) : 0,
      notes: [
        '歷史資料中的零車零位觀測會標為疑似服務異常，且不會被誤判為無車或無位。',
        ...(text(rawMeta.forecastMethod) ? [text(rawMeta.forecastMethod)] : []),
      ],
    },
  }
}

function makeDashboard(source, asOf, scenario, availableTimes, districts) {
  const stations = list(record(scenario).stations).map(station => normalizeStation(station, asOf)).filter((station) => station.id)
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
    inventoryAlerts: alerts.filter((alert) => alert.condition !== 'unavailable').length,
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

function normalizeLiveProfileStation(raw) {
  const source = record(raw)
  const latitude = number(source.latitude, Number.NaN)
  const longitude = number(source.longitude, Number.NaN)
  const slots = list(source.slots).slice(0, 48).map((value) => {
    const profile = list(value)
    if (profile.length !== 6) return null
    return [
      Math.max(0, Math.round(number(profile[0]))),
      Math.max(0, Math.round(number(profile[1]))),
      Math.max(0, Math.round(number(profile[2]))),
      Math.max(0, Math.min(1000, Math.round(number(profile[3])))),
      Math.max(0, Math.min(1000, Math.round(number(profile[4])))),
      Math.max(0, Math.min(1000, Math.round(number(profile[5])))),
    ]
  })

  while (slots.length < 48) slots.push(null)
  const popularity = list(source.popularity).slice(0, 7).map((rawDay) => {
    const hours = list(rawDay).slice(0, 24).map((rawHour) => {
      const value = list(rawHour)
      if (value.length !== 3) return null
      const sampleDays = Math.max(0, Math.round(number(value[0])))
      if (!sampleDays) return null
      return [
        sampleDays,
        Math.max(0, round(number(value[1]), 1)),
        Math.max(0, round(number(value[2]), 1)),
      ]
    })
    while (hours.length < 24) hours.push(null)
    return hours
  })
  while (popularity.length < 7) popularity.push(Array.from({ length: 24 }, () => null))
  const id = text(source.id)
  const matchKey = text(source.matchKey)
  return id && matchKey
    ? {
        id,
        district: text(source.district, '未分類'),
        name: text(source.name, '未命名站點'),
        matchKey,
        latitude: Number.isFinite(latitude) ? latitude : null,
        longitude: Number.isFinite(longitude) ? longitude : null,
        slots,
        popularity,
      }
    : null
}

function normalizeLiveRiskPolicy(raw) {
  const source = record(raw)
  const thresholds = record(source.alertThresholds)
  return {
    version: text(source.version, RISK_POLICY_VERSION),
    alertThresholds: {
      '30': clamp(number(thresholds['30'], alertThresholdFor('30'))),
      '60': clamp(number(thresholds['60'], alertThresholdFor('60'))),
      '120': clamp(number(thresholds['120'], alertThresholdFor('120'))),
    },
  }
}

async function exportLiveProfiles(source, outputDir) {
  const rawProfiles = record(source.liveProfiles)
  const stations = list(rawProfiles.stations)
    .map(normalizeLiveProfileStation)
    .filter(Boolean)
    .sort((left, right) => left.id.localeCompare(right.id))
  if (!stations.length) {
    throw new Error('dashboard.json does not contain a valid liveProfiles artifact. Run npm run data:build before building Pages output.')
  }

  const directory = resolve(outputDir, 'data', 'live-profile')
  await rm(directory, { recursive: true, force: true })
  await mkdir(directory, { recursive: true })

  const paths = {}
  for (let slot = 0; slot < 48; slot += 1) {
    const name = `slot-v2-${String(slot).padStart(2, '0')}.json`
    paths[String(slot)] = '/data/live-profile/' + name
    // Profiles are positionally aligned with manifest.matchKeys. Keeping the
    // station key once in the manifest removes a repeated `st_*` identifier
    // from every half-hour shard while preserving deterministic lookups.
    await writeFile(resolve(directory, name), JSON.stringify({
      slot,
      profiles: stations.map((station) => station.slots[slot]),
    }), 'utf8')
  }

  const popularityPaths = {}
  for (let weekday = 0; weekday < 7; weekday += 1) {
    const name = `popularity-v1-${weekday}.json`
    popularityPaths[String(weekday)] = '/data/live-profile/' + name
    await writeFile(resolve(directory, name), JSON.stringify({
      weekday,
      profiles: stations.map((station) => station.popularity[weekday]),
    }), 'utf8')
  }

  const manifest = {
    schemaVersion: '2.0',
    modelVersion: modelVersion(rawProfiles.modelVersion),
    timezone: text(rawProfiles.timezone, 'Asia/Taipei'),
    riskPolicy: normalizeLiveRiskPolicy(rawProfiles.riskPolicy),
    prediction: predictionMetadata(rawProfiles.prediction, stations),
    stationIds: stations.map((station) => station.id),
    matchKeys: stations.map((station) => station.matchKey),
    slots: paths,
    popularity: popularityPaths,
    popularityValueFormat: ['sampleDays', 'meanAvailableBikes', 'meanAvailableDocks'],
  }
  await writeFile(resolve(directory, 'manifest.json'), JSON.stringify(manifest), 'utf8')

  return { stations: stations.length, output: directory }
}

function fileName(asOf, index) {
  return 'scenario-' + String(index + 1).padStart(2, '0') + '-' + asOf.replace(/[^0-9]/g, '') + '.json'
}

function scenarioLabel(rawScenario) {
  const label = text(record(record(rawScenario).summary).scenarioLabel)
  return {
    morning_pressure: '早尖峰缺車壓力',
    evening_pressure: '晚間雙向供需壓力',
    latest_coverage: '資料末端覆蓋驗證',
  }[label] || '歷史營運情境'
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
  const scenarioLabels = {}
  for (const [index, asOf] of keys.entries()) {
    const name = fileName(asOf, index)
    scenarioPaths[asOf] = '/data/replay/' + name
    scenarioLabels[asOf] = scenarioLabel(scenarios[asOf])
    const dashboard = makeDashboard(source, asOf, scenarios[asOf], availableTimes, list(source.districts).map((value) => text(value)).filter(Boolean))
    await writeFile(resolve(replayDir, name), JSON.stringify(dashboard), 'utf8')
  }

  const manifest = {
    version: 1,
    defaultAsOf: scenarioPaths[defaultAsOf] ? defaultAsOf : keys.at(-1) || '',
    availableTimes,
    districts: list(source.districts).map((value) => text(value)).filter(Boolean),
    scenarios: scenarioPaths,
    labels: scenarioLabels,
  }
  await writeFile(resolve(replayDir, 'manifest.json'), JSON.stringify(manifest), 'utf8')
  const liveProfiles = await exportLiveProfiles(source, outputDir)

  return {
    scenarios: keys.length,
    defaultAsOf: manifest.defaultAsOf,
    output: replayDir,
    liveProfiles,
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const outputDir = resolve(APP_DIR, 'dist')
  const result = await exportReplayStatic(outputDir)
  console.log('Exported ' + result.scenarios + ' static replay scenarios to ' + result.output)
}
