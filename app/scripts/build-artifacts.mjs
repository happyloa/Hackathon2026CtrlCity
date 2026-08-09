import { createReadStream } from 'node:fs'
import { mkdir, open, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { parse } from 'csv-parse'
import iconv from 'iconv-lite'

import { deriveStatePersistence } from './alert-persistence.mjs'
import {
  createScenarioProfileStats,
  profileKey,
  updateProfile,
  updateScenarioProfileStats,
} from './scenario-profile-cutoff.mjs'
import {
  ALERT_THRESHOLDS,
  HORIZON_MINUTES,
  RISK_POLICY_VERSION,
  alertSeverityFor,
  alertThresholdFor,
} from './risk-policy.mjs'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const APP_DIR = resolve(SCRIPT_DIR, '..')
const REPO_DIR = resolve(APP_DIR, '..')
const SOURCE_DIR = resolve(REPO_DIR, 'docs', '資料集')
const OUTPUT_FILE = resolve(APP_DIR, 'data', 'dashboard.json')
const ALIAS_FILE = resolve(SCRIPT_DIR, 'station-aliases.json')

const HALF_HOUR_MS = 30 * 60 * 1000
const HISTORY_POINTS = 12
const MAX_ALERTS = 18
const MAX_DISPATCHES = 12
const SAFE_INVENTORY_RATIO = 0.35
const MAX_MOVE_BIKES = 8

const HEADER_MAP = new Map([
  ['日期', 'observedAt'],
  ['城市', 'city'],
  ['行政區', 'district'],
  ['場站名稱', 'name'],
  ['總車柱數', 'totalDocks'],
  ['可借車數', 'availableBikes'],
  ['可還位數', 'availableDocks'],
  ['經度', 'longitude'],
  ['緯度', 'latitude'],
])

const REQUIRED_COLUMNS = Object.freeze([
  'observedAt',
  'city',
  'district',
  'name',
  'totalDocks',
  'availableBikes',
  'availableDocks',
  'longitude',
  'latitude',
])

const STATE_VALUES = new Set([
  'normal',
  'low_bikes',
  'low_docks',
  'empty',
  'full',
  'unavailable',
])

function normalizeText(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .replace(/^\uFEFF/, '')
    .trim()
    .replace(/\s+/g, ' ')
}

function normalizeStationName(value) {
  return normalizeText(value)
    .replace(/^YouBike\s*2(?:\.0)?[_\s-]*/i, '')
    .replace(/^YouBike[_\s-]*/i, '')
}

function liveMatchKey(district, name) {
  return `${normalizeText(district)}|${normalizeStationName(name)}`
}

function pad(value) {
  return String(value).padStart(2, '0')
}

function formatAt(epoch) {
  const date = new Date(epoch)
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}T${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:00+08:00`
}

function formatObservedAt(year, month, day, hour, minute, second) {
  return `${year}-${pad(month)}-${pad(day)}T${pad(hour)}:${pad(minute)}:${pad(second)}+08:00`
}

function parseLocalTimestamp(value) {
  const match = normalizeText(value).match(
    /^(\d{4})[/-](\d{1,2})[/-](\d{1,2})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?$/,
  )

  if (!match) return null

  const [, yearText, monthText, dayText, hourText, minuteText, secondText] = match
  const year = Number(yearText)
  const month = Number(monthText)
  const day = Number(dayText)
  const hour = Number(hourText)
  const minute = Number(minuteText)
  const second = Number(secondText ?? 0)

  if (
    !Number.isInteger(year) ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31 ||
    hour < 0 ||
    hour > 23 ||
    minute < 0 ||
    minute > 59 ||
    second < 0 ||
    second > 59
  ) {
    return null
  }

  const observedEpoch = Date.UTC(year, month - 1, day, hour, minute, second)
  const observedDate = new Date(observedEpoch)
  if (
    observedDate.getUTCFullYear() !== year ||
    observedDate.getUTCMonth() !== month - 1 ||
    observedDate.getUTCDate() !== day
  ) {
    return null
  }

  const bucketMinute = Math.floor(minute / 30) * 30
  const bucketEpoch = Date.UTC(year, month - 1, day, hour, bucketMinute, 0)

  return {
    observedAt: formatObservedAt(year, month, day, hour, minute, second),
    observedEpoch,
    bucketAt: formatAt(bucketEpoch),
    bucketEpoch,
    slot: hour * 2 + Math.floor(bucketMinute / 30),
    weekday: new Date(bucketEpoch).getUTCDay(),
  }
}

function parseFiniteNumber(value) {
  const parsed = Number(normalizeText(value))
  return Number.isFinite(parsed) ? parsed : null
}

function asCount(value) {
  return Number.isInteger(value) ? value : null
}

function clamp(value, min = 0, max = 1) {
  return Math.min(max, Math.max(min, value))
}

function round(value, decimals = 3) {
  const factor = 10 ** decimals
  return Math.round(value * factor) / factor
}

function stableId(identityKey) {
  return `st_${createHash('sha256').update(identityKey).digest('hex').slice(0, 14)}`
}

function stateForSnapshot(totalDocks, availableBikes, availableDocks) {
  if (availableBikes === 0 && availableDocks === 0) return 'unavailable'
  if (availableBikes === 0 && availableDocks > 0) return 'empty'
  if (availableDocks === 0 && availableBikes > 0) return 'full'

  const lowThreshold = Math.max(2, Math.ceil(totalDocks * 0.1))
  if (availableBikes <= lowThreshold) return 'low_bikes'
  if (availableDocks <= lowThreshold) return 'low_docks'
  return 'normal'
}

function calculateQualityFlags({
  rawName,
  aliasApplied,
  district,
  latitude,
  longitude,
  totalDocks,
  availableBikes,
  availableDocks,
  currentState,
}) {
  const flags = []
  if (aliasApplied) flags.push('station_name_alias_applied')
  else if (rawName.includes('?')) flags.push('encoded_name_unresolved')
  if (!district) flags.push('missing_district')
  if (latitude === null || longitude === null) flags.push('missing_coordinates')
  if (totalDocks !== availableBikes + availableDocks) flags.push('capacity_gap')
  if (currentState === 'unavailable') {
    flags.push('zero_inventory_snapshot', 'service_status_inferred')
  }
  return flags
}

function addFlagCount(quality, flags) {
  for (const flag of flags) {
    quality.flagCounts[flag] = (quality.flagCounts[flag] ?? 0) + 1
  }
}

function safeDistrict(district) {
  return district || '未標示行政區'
}

function detectCriticality(station) {
  const horizon = station.forecast.horizons['60']
  if (station.serviceStatus !== 'operational') return 'critical'
  const risk = Math.max(horizon.emptyRisk, horizon.fullRisk)
  return alertSeverityFor(risk, '60', {
    currentFailure: station.currentState === 'empty' || station.currentState === 'full',
  })
}

function haversineKm(a, b) {
  if (
    a.latitude === null ||
    a.longitude === null ||
    b.latitude === null ||
    b.longitude === null
  ) {
    return null
  }

  const toRadians = (degrees) => (degrees * Math.PI) / 180
  const earthRadiusKm = 6371
  const deltaLatitude = toRadians(b.latitude - a.latitude)
  const deltaLongitude = toRadians(b.longitude - a.longitude)
  const latitudeA = toRadians(a.latitude)
  const latitudeB = toRadians(b.latitude)
  const sinLatitude = Math.sin(deltaLatitude / 2)
  const sinLongitude = Math.sin(deltaLongitude / 2)
  const value =
    sinLatitude * sinLatitude +
    Math.cos(latitudeA) * Math.cos(latitudeB) * sinLongitude * sinLongitude

  return earthRadiusKm * 2 * Math.atan2(Math.sqrt(value), Math.sqrt(1 - value))
}

async function detectEncoding(filePath) {
  const handle = await open(filePath, 'r')
  try {
    const bytes = Buffer.alloc(4)
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0)
    const hasUtf8Bom = bytesRead >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf
    const startsWithQuote = bytesRead >= 1 && bytes[0] === 0x22
    return hasUtf8Bom || startsWithQuote ? 'utf8' : 'cp950'
  } finally {
    await handle.close()
  }
}

async function listSourceFiles() {
  const entries = await readdir(SOURCE_DIR, { withFileTypes: true })
  return entries
    .filter((entry) => entry.isFile() && extname(entry.name).toLowerCase() === '.csv')
    .map((entry) => join(SOURCE_DIR, entry.name))
    .sort((left, right) => left.localeCompare(right, 'zh-Hant'))
}

async function loadAliases() {
  const content = await readFile(ALIAS_FILE, 'utf8')
  const rawAliases = JSON.parse(content)
  return new Map(
    Object.entries(rawAliases).map(([raw, canonical]) => [normalizeText(raw), normalizeText(canonical)]),
  )
}

async function streamRows(filePath, onRow) {
  const encoding = await detectEncoding(filePath)
  const input = createReadStream(filePath)
  const decoder = iconv.decodeStream(encoding)
  let headerValidated = false
  let sourceRow = 1

  const parser = parse({
    bom: true,
    columns: (header) => {
      const columns = header.map((column) => HEADER_MAP.get(normalizeText(column)) ?? `unknown_${normalizeText(column)}`)
      const actual = new Set(columns)
      const missing = REQUIRED_COLUMNS.filter((column) => !actual.has(column))
      if (missing.length > 0) {
        throw new Error(`Unexpected CSV header in ${filePath}; missing ${missing.join(', ')}`)
      }
      headerValidated = true
      return columns
    },
    skip_empty_lines: true,
    trim: true,
    relax_column_count: false,
  })

  input.pipe(decoder).pipe(parser)
  for await (const row of parser) {
    sourceRow += 1
    await onRow(row, { encoding, sourceRow })
  }

  if (!headerValidated) {
    throw new Error(`CSV header was not read from ${filePath}`)
  }

  return { encoding, rows: sourceRow - 1 }
}

function toSnapshot(row, source, aliases, stationIndex, quality, districts) {
  const timestamp = parseLocalTimestamp(row.observedAt)
  if (!timestamp) {
    quality.invalidTimestampRows += 1
    return null
  }

  const totalDocks = asCount(parseFiniteNumber(row.totalDocks))
  const availableBikes = asCount(parseFiniteNumber(row.availableBikes))
  const availableDocks = asCount(parseFiniteNumber(row.availableDocks))
  const latitude = parseFiniteNumber(row.latitude)
  const longitude = parseFiniteNumber(row.longitude)

  if (
    totalDocks === null ||
    availableBikes === null ||
    availableDocks === null ||
    totalDocks < 0 ||
    availableBikes < 0 ||
    availableDocks < 0 ||
    (latitude !== null && (latitude < -90 || latitude > 90)) ||
    (longitude !== null && (longitude < -180 || longitude > 180))
  ) {
    quality.invalidNumericRows += 1
    return null
  }

  const city = normalizeText(row.city)
  const district = normalizeText(row.district)
  const rawName = normalizeText(row.name)
  const canonicalName = aliases.get(rawName) ?? rawName
  const aliasApplied = canonicalName !== rawName
  const identityKey = `${city}|${district}|${canonicalName}`
  let station = stationIndex.get(identityKey)

  if (!station) {
    station = {
      id: stableId(identityKey),
      name: canonicalName,
      city,
      district,
      identityKey,
      matchKey: liveMatchKey(district, canonicalName),
      latitude,
      longitude,
    }
    stationIndex.set(identityKey, station)
  } else if (latitude !== null && longitude !== null) {
    station.latitude = latitude
    station.longitude = longitude
  }

  if (district) districts.add(district)

  const currentState = stateForSnapshot(totalDocks, availableBikes, availableDocks)
  const qualityFlags = calculateQualityFlags({
    rawName,
    aliasApplied,
    district,
    latitude,
    longitude,
    totalDocks,
    availableBikes,
    availableDocks,
    currentState,
  })

  addFlagCount(quality, qualityFlags)

  return {
    id: station.id,
    name: station.name,
    city,
    district: safeDistrict(district),
    latitude,
    longitude,
    totalDocks,
    availableBikes,
    availableDocks,
    capacityGap: totalDocks - availableBikes - availableDocks,
    currentState,
    serviceStatus: currentState === 'unavailable' ? 'suspected_unavailable' : 'operational',
    qualityFlags,
    sourceFile: source.fileName,
    sourceRow: source.sourceRow,
    rawObservedAt: timestamp.observedAt,
    observedEpoch: timestamp.observedEpoch,
    at: timestamp.bucketAt,
    epoch: timestamp.bucketEpoch,
    slot: timestamp.slot,
    weekday: timestamp.weekday,
  }
}

function getBucket(bucketStats, snapshot) {
  let bucket = bucketStats.get(snapshot.epoch)
  if (!bucket) {
    bucket = {
      at: snapshot.at,
      epoch: snapshot.epoch,
      hour: Math.floor(snapshot.slot / 2),
      rows: 0,
      empty: 0,
      full: 0,
      unavailable: 0,
      lowBikes: 0,
      lowDocks: 0,
      capacityGap: 0,
    }
    bucketStats.set(snapshot.epoch, bucket)
  }
  return bucket
}

function bucketRiskScore(bucket) {
  const operationalRows = Math.max(1, bucket.rows - bucket.unavailable)
  return (bucket.empty + bucket.full) / operationalRows
}

function chooseScenarios(bucketStats) {
  const buckets = [...bucketStats.values()].sort((left, right) => left.epoch - right.epoch)
  if (buckets.length === 0) throw new Error('No valid half-hour snapshots were found')

  const selected = []
  const selectedEpochs = new Set()
  const add = (label, predicate) => {
    const candidates = buckets
      .filter((bucket) => !selectedEpochs.has(bucket.epoch) && predicate(bucket))
      .sort((left, right) => {
        const riskDifference = bucketRiskScore(right) - bucketRiskScore(left)
        return riskDifference || right.epoch - left.epoch
      })
    const candidate = candidates[0]
    if (!candidate) return false
    selected.push({ ...candidate, label })
    selectedEpochs.add(candidate.epoch)
    return true
  }

  const latest = buckets.at(-1)
  selected.push({ ...latest, label: 'latest_coverage' })
  selectedEpochs.add(latest.epoch)

  add('morning_pressure', (bucket) => bucket.hour >= 7 && bucket.hour <= 9)
  add('evening_pressure', (bucket) => bucket.hour >= 17 && bucket.hour <= 20)

  for (const bucket of [...buckets].reverse()) {
    if (selected.length >= 3) break
    if (!selectedEpochs.has(bucket.epoch)) {
      selected.push({ ...bucket, label: `coverage_${selected.length + 1}` })
      selectedEpochs.add(bucket.epoch)
    }
  }

  return selected.sort((left, right) => left.epoch - right.epoch)
}

function profileFor(profileStats, stationId, epoch) {
  const date = new Date(epoch)
  const slot = date.getUTCHours() * 2 + Math.floor(date.getUTCMinutes() / 30)
  return profileStats.get(profileKey(stationId, slot)) ?? null
}

function makeForecast(snapshot, history, profileStats) {
  const horizons = {}
  for (const minutes of HORIZON_MINUTES) {
    const targetEpoch = snapshot.epoch + minutes * 60 * 1000
    const profile = profileFor(profileStats, snapshot.id, targetEpoch)
    const observations = profile?.observations ?? 0
    const profileEmptyRisk = observations ? profile.empty / observations : 0
    const profileFullRisk = observations ? profile.full / observations : 0
    const profileUnavailableRisk = profile
      ? profile.unavailable / Math.max(1, profile.observations + profile.unavailable)
      : 0
    const weight = Math.min(0.55, minutes / 240)
    const lowThreshold = Math.max(2, Math.ceil(snapshot.totalDocks * 0.1))
    const bikeRatio = snapshot.availableBikes / Math.max(1, snapshot.totalDocks)
    const dockRatio = snapshot.availableDocks / Math.max(1, snapshot.totalDocks)
    const previous = history.length >= 2 ? history.at(-2) : null
    const bikeMomentum = previous ? snapshot.availableBikes - previous.bikes : 0
    const dockMomentum = previous ? snapshot.availableDocks - previous.docks : 0

    let emptyRisk = profileEmptyRisk * 0.7
    let fullRisk = profileFullRisk * 0.7
    let unavailableRisk = profileUnavailableRisk * 0.5

    if (snapshot.currentState === 'unavailable') {
      unavailableRisk = 0.98
      emptyRisk = 0
      fullRisk = 0
    } else {
      if (snapshot.currentState === 'empty') emptyRisk += 0.48
      else if (snapshot.availableBikes <= lowThreshold || bikeRatio <= 0.1) emptyRisk += 0.25
      if (snapshot.currentState === 'full') fullRisk += 0.48
      else if (snapshot.availableDocks <= lowThreshold || dockRatio <= 0.1) fullRisk += 0.25
      if (bikeMomentum < 0) emptyRisk += Math.min(0.12, Math.abs(bikeMomentum) / Math.max(1, snapshot.totalDocks))
      if (dockMomentum < 0) fullRisk += Math.min(0.12, Math.abs(dockMomentum) / Math.max(1, snapshot.totalDocks))
    }

    const profileBikes = observations ? profile.bikesSum / observations : snapshot.availableBikes
    const profileDocks = observations ? profile.docksSum / observations : snapshot.availableDocks
    const predictedBikes = Math.max(0, Math.round(snapshot.availableBikes * (1 - weight) + profileBikes * weight))
    const predictedDocks = Math.max(0, Math.round(snapshot.availableDocks * (1 - weight) + profileDocks * weight))
    const reasons = []
    if (snapshot.currentState === 'unavailable') reasons.push('場站同時無車與無可還位，屬疑似服務異常，需人工確認')
    if (snapshot.currentState === 'empty') reasons.push('目前已無可借車')
    if (snapshot.currentState === 'full') reasons.push('目前已無可還位')
    if (snapshot.availableBikes <= lowThreshold && snapshot.currentState !== 'empty') reasons.push('目前可借車低於預警門檻')
    if (snapshot.availableDocks <= lowThreshold && snapshot.currentState !== 'full') reasons.push('目前可還位低於預警門檻')
    if (profileEmptyRisk >= 0.15) reasons.push('同時槽歷史無車風險偏高')
    if (profileFullRisk >= 0.1) reasons.push('同時槽歷史無位風險偏高')
    if (reasons.length === 0) reasons.push('目前庫存與同時槽歷史型態穩定')

    horizons[String(minutes)] = {
      at: formatAt(targetEpoch),
      emptyRisk: round(clamp(emptyRisk)),
      fullRisk: round(clamp(fullRisk)),
      unavailableRisk: round(clamp(unavailableRisk)),
      predictedBikes,
      predictedDocks,
      confidence: round(Math.min(1, observations / 12)),
      sampleSize: observations,
      alertThreshold: alertThresholdFor(minutes),
      baselineStatus: 'matched',
      method: 'historical_replay',
      reasons: reasons.slice(0, 3),
    }
  }

  return { horizons }
}

function makeStation(snapshot, history, profileStats) {
  const orderedSnapshots = [...history].sort((left, right) => left.epoch - right.epoch)
  const orderedHistory = [...history]
    .sort((left, right) => left.epoch - right.epoch)
    .map((item) => ({ at: item.at, bikes: item.availableBikes, docks: item.availableDocks }))

  const station = {
    id: snapshot.id,
    name: snapshot.name,
    district: snapshot.district,
    city: snapshot.city,
    latitude: snapshot.latitude,
    longitude: snapshot.longitude,
    totalDocks: snapshot.totalDocks,
    availableBikes: snapshot.availableBikes,
    availableDocks: snapshot.availableDocks,
    capacityGap: snapshot.capacityGap,
    currentState: snapshot.currentState,
    serviceStatus: snapshot.serviceStatus,
    qualityFlags: snapshot.qualityFlags,
    forecast: makeForecast(snapshot, orderedHistory, profileStats),
  }

  station.severity = detectCriticality(station)
  return {
    station,
    history: orderedHistory,
    persistence: deriveStatePersistence(orderedSnapshots, snapshot),
  }
}

function makeAlerts(stations, persistenceByStation, scenarioAt) {
  return stations
    .map((station) => {
      const horizon = station.forecast.horizons['60']
      const inventoryRisk = Math.max(horizon.emptyRisk, horizon.fullRisk)
      const isServiceReview = station.serviceStatus !== 'operational'
      const risk = isServiceReview ? horizon.unavailableRisk : inventoryRisk
      const type =
        isServiceReview
          ? 'unavailable'
          : station.currentState === 'empty'
            ? 'empty'
            : station.currentState === 'full'
              ? 'full'
              : horizon.emptyRisk >= horizon.fullRisk
                ? 'empty'
                : 'full'
      const persistence = persistenceByStation.get(station.id)
      const isCurrentInventoryFailure = station.currentState === 'empty' || station.currentState === 'full' || isServiceReview
      return {
        id: `alert_${station.id}`,
        stationId: station.id,
        stationName: station.name,
        district: station.district,
        severity: station.severity,
        type,
        risk: round(risk),
        currentState: station.currentState,
        startedAt: persistence?.startedAt ?? scenarioAt,
        durationMinutes: persistence?.durationMinutes ?? (isCurrentInventoryFailure ? 30 : 60),
        message:
          type === 'unavailable'
            ? '站點呈現疑似服務異常，需先確認設備或營運狀態。'
            : type === 'empty'
              ? '未來 60 分鐘可借車不足風險偏高。'
              : '未來 60 分鐘可還位不足風險偏高。',
      }
    })
    .filter((alert) => alert.severity !== 'normal')
    .sort((left, right) => {
      const severityOrder = { critical: 2, warning: 1, normal: 0 }
      return severityOrder[right.severity] - severityOrder[left.severity] || right.risk - left.risk
    })
    .slice(0, MAX_ALERTS)
}

function safeInventory(station) {
  return Math.max(2, Math.ceil(station.totalDocks * SAFE_INVENTORY_RATIO))
}

function dispatchPriority({ risk, gap, currentFailure, distanceKm }) {
  const value = risk * 68 + Math.min(18, gap * 3) + (currentFailure ? 16 : 0) - Math.min(12, distanceKm * 1.5)
  return round(Math.max(0, Math.min(100, value)), 1)
}

function dispatchLabel(operation) {
  return operation === 'remove_bikes' ? '移出滿站車輛' : '補入缺車站點'
}

function makeDispatches(stations) {
  const operational = stations.filter((station) => station.currentState !== 'unavailable')
  const bikeSupply = new Map(operational.map((station) => [
    station.id,
    Math.max(0, station.availableBikes - safeInventory(station)),
  ]))
  const dockSupply = new Map(operational.map((station) => [
    station.id,
    Math.max(0, station.availableDocks - safeInventory(station)),
  ]))
  const horizonKey = '60'
  const threshold = alertThresholdFor(horizonKey)
  const tasks = []

  for (const station of operational) {
    const forecast = station.forecast.horizons[horizonKey]
    const emptyCurrent = station.currentState === 'empty'
    const fullCurrent = station.currentState === 'full'
    const emptyGap = Math.max(0, safeInventory(station) - Math.min(station.availableBikes, forecast.predictedBikes))
    const fullGap = Math.max(0, safeInventory(station) - Math.min(station.availableDocks, forecast.predictedDocks))

    if (emptyGap >= 2 && (emptyCurrent || forecast.emptyRisk >= threshold)) {
      tasks.push({
        operation: 'deliver_bikes',
        station,
        gap: emptyGap,
        risk: forecast.emptyRisk,
        currentFailure: emptyCurrent,
      })
    }
    if (fullGap >= 2 && (fullCurrent || forecast.fullRisk >= threshold)) {
      tasks.push({
        operation: 'remove_bikes',
        station,
        gap: fullGap,
        risk: forecast.fullRisk,
        currentFailure: fullCurrent,
      })
    }
  }

  tasks.sort((left, right) =>
    Number(right.currentFailure) - Number(left.currentFailure) || right.risk - left.risk || right.gap - left.gap,
  )

  const dispatches = []
  for (const task of tasks) {
    if (dispatches.length >= MAX_DISPATCHES) break
    let best = null

    for (const candidate of operational) {
      if (candidate.id === task.station.id) continue
      const candidateForecast = candidate.forecast.horizons[horizonKey]
      const remaining = task.operation === 'deliver_bikes'
        ? bikeSupply.get(candidate.id) ?? 0
        : dockSupply.get(candidate.id) ?? 0
      const competingRisk = task.operation === 'deliver_bikes'
        ? candidateForecast.emptyRisk
        : candidateForecast.fullRisk
      if (remaining < 2 || competingRisk >= threshold) continue

      const distanceKm = haversineKm(candidate, task.station)
      if (distanceKm === null) continue
      const score = distanceKm + competingRisk * 3
      if (!best || score < best.score) best = { candidate, distanceKm, score, remaining }
    }
    if (!best) continue

    const suggestedBikes = Math.max(1, Math.min(task.gap, best.remaining, MAX_MOVE_BIKES))
    if (task.operation === 'deliver_bikes') {
      bikeSupply.set(best.candidate.id, best.remaining - suggestedBikes)
    } else {
      dockSupply.set(best.candidate.id, best.remaining - suggestedBikes)
    }

    const source = task.operation === 'deliver_bikes' ? best.candidate : task.station
    const destination = task.operation === 'deliver_bikes' ? task.station : best.candidate
    const priorityScore = dispatchPriority({
      risk: task.risk,
      gap: task.gap,
      currentFailure: task.currentFailure,
      distanceKm: best.distanceKm,
    })
    dispatches.push({
      id: `dispatch_${task.operation}_${source.id}_${destination.id}`,
      operation: task.operation,
      sourceStationId: source.id,
      sourceStationName: source.name,
      destinationStationId: destination.id,
      destinationStationName: destination.name,
      suggestedBikes,
      distanceKm: round(best.distanceKm, 2),
      priorityScore,
      priority: priorityScore >= 70 ? 'high' : 'medium',
      rationale: `${dispatchLabel(task.operation)}：${task.operation === 'deliver_bikes' ? '目的站無車' : '來源站無位'}風險 ${Math.round(task.risk * 100)}，預估缺口 ${task.gap}，採用 ${best.distanceKm.toFixed(1)} km 的鄰近站點。`,
    })
  }

  return dispatches.sort((left, right) => right.priorityScore - left.priorityScore || left.distanceKm - right.distanceKm)
}

function makeSummary({ scenario, stations, alerts, dispatches }) {
  const byState = Object.fromEntries([...STATE_VALUES].map((state) => [state, 0]))
  let capacityGapStations = 0
  let criticalAlerts = 0
  let warningAlerts = 0

  for (const station of stations) {
    byState[station.currentState] += 1
    if (station.capacityGap !== 0) capacityGapStations += 1
  }
  for (const alert of alerts) {
    if (alert.severity === 'critical') criticalAlerts += 1
    if (alert.severity === 'warning') warningAlerts += 1
  }

  return {
    at: scenario.at,
    scenarioLabel: scenario.label,
    totalStations: stations.length,
    operationalStations: stations.length - byState.unavailable,
    emptyStations: byState.empty,
    fullStations: byState.full,
    unavailableStations: byState.unavailable,
    lowBikeStations: byState.low_bikes,
    lowDockStations: byState.low_docks,
    normalStations: byState.normal,
    capacityGapStations,
    criticalAlerts,
    warningAlerts,
    dispatchRecommendations: dispatches.length,
  }
}

function compactProfile(profile) {
  if (!profile) return null
  const observations = Math.max(0, profile.observations)
  const totalObservations = observations + Math.max(0, profile.unavailable)
  return [
    observations,
    observations ? Math.round(profile.bikesSum / observations) : 0,
    observations ? Math.round(profile.docksSum / observations) : 0,
    observations ? Math.round((profile.empty / observations) * 1000) : 0,
    observations ? Math.round((profile.full / observations) * 1000) : 0,
    totalObservations ? Math.round((profile.unavailable / totalObservations) * 1000) : 0,
  ]
}

function makeLiveProfiles(stationIndex, profileStats) {
  const stations = [...stationIndex.values()]
    .map((station) => ({
      id: station.id,
      city: station.city,
      district: safeDistrict(station.district),
      name: station.name,
      matchKey: station.matchKey,
      latitude: station.latitude,
      longitude: station.longitude,
      slots: Array.from({ length: 48 }, (_, slot) => compactProfile(profileStats.get(profileKey(station.id, slot)))),
    }))
    .sort((left, right) => left.id.localeCompare(right.id))

  return {
    schemaVersion: '1.0',
    modelVersion: 'historical-profile-heuristic-v1',
    timezone: 'Asia/Taipei',
    riskPolicy: {
      version: RISK_POLICY_VERSION,
      alertThresholds: ALERT_THRESHOLDS,
    },
    // Array values are [sample count, mean bikes, mean docks, empty risk,
    // full risk, inferred service-review rate]. Risk rates use per mille
    // integers to keep the artifact small and static-CDN friendly.
    profileValueFormat: ['sampleCount', 'meanBikes', 'meanDocks', 'emptyRiskPermille', 'fullRiskPermille', 'serviceReviewPermille'],
    stations,
  }
}

function makeBriefingFacts(summary, alerts, dispatches) {
  const deliveryCount = dispatches.filter((dispatch) => dispatch.operation === 'deliver_bikes').length
  const removalCount = dispatches.filter((dispatch) => dispatch.operation === 'remove_bikes').length
  const facts = [
    `回放時點 ${summary.at}，共覆蓋 ${summary.totalStations} 個場站。`,
    `目前無車 ${summary.emptyStations} 站、無位 ${summary.fullStations} 站、疑似服務異常 ${summary.unavailableStations} 站。`,
    `已依 60 分鐘風險產生 ${summary.dispatchRecommendations} 筆人工覆核調度建議（補車 ${deliveryCount}、移車 ${removalCount}）。`,
  ]
  if (alerts[0]) {
    facts.push(`最高優先告警為 ${alerts[0].stationName}（${alerts[0].district}），風險指標 ${Math.round(alerts[0].risk * 100)}／100。`)
  }
  if (dispatches[0]) {
    facts.push(`優先調度建議由 ${dispatches[0].sourceStationName} 向 ${dispatches[0].destinationStationName} 搬運 ${dispatches[0].suggestedBikes} 車。`)
  }
  return facts
}

function buildScenario(scenario, captured, profileStats) {
  const stations = []
  const stationHistories = {}
  const persistenceByStation = new Map()

  for (const historyByAt of captured.recordsByStation.values()) {
    const current = historyByAt.get(scenario.epoch)
    if (!current) continue
    const history = [...historyByAt.values()]
    const { station, history: formattedHistory, persistence } = makeStation(current, history, profileStats)
    stations.push(station)
    stationHistories[station.id] = formattedHistory
    if (persistence) persistenceByStation.set(station.id, persistence)
  }

  stations.sort((left, right) => {
    const severityOrder = { critical: 2, warning: 1, normal: 0 }
    const leftRisk = Math.max(...Object.values(left.forecast.horizons).map((horizon) => Math.max(horizon.emptyRisk, horizon.fullRisk)))
    const rightRisk = Math.max(...Object.values(right.forecast.horizons).map((horizon) => Math.max(horizon.emptyRisk, horizon.fullRisk)))
    return severityOrder[right.severity] - severityOrder[left.severity] || rightRisk - leftRisk || left.name.localeCompare(right.name, 'zh-Hant')
  })

  const alerts = makeAlerts(stations, persistenceByStation, scenario.at)
  const dispatches = makeDispatches(stations)
  const summary = makeSummary({ scenario, stations, alerts, dispatches })
  const briefingFacts = makeBriefingFacts(summary, alerts, dispatches)

  return { summary, stations, alerts, dispatches, briefingFacts, stationHistories }
}

async function main() {
  const aliases = await loadAliases()
  const sourceFiles = await listSourceFiles()
  if (sourceFiles.length === 0) {
    throw new Error(`No CSV files were found at ${SOURCE_DIR}`)
  }

  const stationIndex = new Map()
  const districts = new Set()
  const profileStats = new Map()
  const bucketStats = new Map()
  const quality = {
    rawRows: 0,
    validRows: 0,
    invalidTimestampRows: 0,
    invalidNumericRows: 0,
    unavailableRowsExcludedFromProfile: 0,
    flagCounts: {},
    encodings: {},
    files: [],
  }

  console.log(`Building first pass from ${sourceFiles.length} source files...`)
  for (const filePath of sourceFiles) {
    const fileName = filePath.slice(filePath.lastIndexOf('\\') + 1)
    let validRowsInFile = 0
    const result = await streamRows(filePath, async (row, source) => {
      quality.rawRows += 1
      const snapshot = toSnapshot(row, { ...source, fileName }, aliases, stationIndex, quality, districts)
      if (!snapshot) return
      quality.validRows += 1
      validRowsInFile += 1

      const bucket = getBucket(bucketStats, snapshot)
      bucket.rows += 1
      if (snapshot.currentState === 'empty') bucket.empty += 1
      if (snapshot.currentState === 'full') bucket.full += 1
      if (snapshot.currentState === 'unavailable') {
        bucket.unavailable += 1
        quality.unavailableRowsExcludedFromProfile += 1
      }
      if (snapshot.currentState === 'low_bikes') bucket.lowBikes += 1
      if (snapshot.currentState === 'low_docks') bucket.lowDocks += 1
      if (snapshot.capacityGap !== 0) bucket.capacityGap += 1

      updateProfile(profileStats, snapshot)
    })
    quality.encodings[result.encoding] = (quality.encodings[result.encoding] ?? 0) + 1
    quality.files.push({ fileName, encoding: result.encoding, rows: result.rows, validRows: validRowsInFile })
    console.log(`  ${fileName}: ${result.rows.toLocaleString()} rows (${result.encoding})`)
  }

  const scenarios = chooseScenarios(bucketStats)
  const scenarioCaptures = new Map(
    scenarios.map((scenario) => [
      scenario.epoch,
      { ...scenario, recordsByStation: new Map() },
    ]),
  )
  const scenarioProfileStats = createScenarioProfileStats(scenarios)
  const replayParseQuality = {
    invalidTimestampRows: 0,
    invalidNumericRows: 0,
    flagCounts: {},
  }
  const replayDistricts = new Set()
  const windowTargets = new Map()
  for (const scenario of scenarios) {
    for (let point = 0; point <= HISTORY_POINTS; point += 1) {
      const epoch = scenario.epoch - point * HALF_HOUR_MS
      const targets = windowTargets.get(epoch) ?? []
      targets.push(scenario.epoch)
      windowTargets.set(epoch, targets)
    }
  }

  console.log(`Building ${scenarios.length} as-of profile sets and capturing actual replay scenarios in a second streaming pass...`)
  for (const filePath of sourceFiles) {
    const fileName = filePath.slice(filePath.lastIndexOf('\\') + 1)
    await streamRows(filePath, async (row, source) => {
      const timestamp = parseLocalTimestamp(row.observedAt)
      if (!timestamp) return
      const captureTargets = windowTargets.get(timestamp.bucketEpoch) ?? []
      const contributesToProfile = scenarios.some((scenario) => timestamp.bucketEpoch < scenario.epoch)
      if (!captureTargets.length && !contributesToProfile) return

      const snapshot = toSnapshot(
        row,
        { ...source, fileName },
        aliases,
        stationIndex,
        replayParseQuality,
        replayDistricts,
      )
      if (!snapshot) return

      updateScenarioProfileStats(scenarioProfileStats, scenarios, snapshot)

      for (const scenarioEpoch of captureTargets) {
        const capture = scenarioCaptures.get(scenarioEpoch)
        let historyByAt = capture.recordsByStation.get(snapshot.id)
        if (!historyByAt) {
          historyByAt = new Map()
          capture.recordsByStation.set(snapshot.id, historyByAt)
        }
        const prior = historyByAt.get(snapshot.epoch)
        if (!prior || snapshot.observedEpoch > prior.observedEpoch) {
          historyByAt.set(snapshot.epoch, snapshot)
        }
      }
    })
    console.log(`  captured ${fileName}`)
  }

  const scenarioArtifacts = {}
  for (const scenario of scenarios) {
    const capture = scenarioCaptures.get(scenario.epoch)
    const asOfProfileStats = scenarioProfileStats.get(scenario.epoch)
    scenarioArtifacts[scenario.at] = buildScenario(capture, capture, asOfProfileStats)
  }

  // Prefer a real scenario with both directions so the default historical
  // demo can explain replenishment and removal without manufacturing a task.
  const defaultScenario = scenarios.find((scenario) => {
    const operations = new Set(scenarioArtifacts[scenario.at].dispatches.map((dispatch) => dispatch.operation))
    return operations.has('deliver_bikes') && operations.has('remove_bikes')
  }) || scenarios.at(-1)
  const defaultArtifact = scenarioArtifacts[defaultScenario.at]
  const liveProfiles = makeLiveProfiles(stationIndex, profileStats)
  const availableTimes = [...bucketStats.values()]
    .sort((left, right) => left.epoch - right.epoch)
    .map((bucket) => bucket.at)
  const coverage = {
    sourceFiles: sourceFiles.length,
    rawRows: quality.rawRows,
    validRows: quality.validRows,
    firstAt: availableTimes[0],
    lastAt: availableTimes.at(-1),
    availableTimeCount: availableTimes.length,
    stationIdentities: stationIndex.size,
  }
  const dashboard = {
    meta: {
      asOf: defaultScenario.at,
      generatedAt: new Date().toISOString(),
      dataMode: 'historical_replay',
      modelVersion: 'historical-profile-heuristic-v1',
      forecastMethod: 'Current inventory plus an as-of station half-hour historical profile built only from buckets strictly earlier than each replay scenario; zero-inventory observations are excluded from empty/full risk profiles and remain an inferred service-status flag.',
      riskPolicy: {
        version: RISK_POLICY_VERSION,
        alertThresholds: ALERT_THRESHOLDS,
      },
      coverage,
      quality,
    },
    availableTimes,
    districts: [...districts].sort((left, right) => left.localeCompare(right, 'zh-Hant')),
    summary: defaultArtifact.summary,
    stations: defaultArtifact.stations,
    alerts: defaultArtifact.alerts,
    dispatches: defaultArtifact.dispatches,
    briefingFacts: defaultArtifact.briefingFacts,
    stationHistories: defaultArtifact.stationHistories,
    liveProfiles,
    scenarios: scenarioArtifacts,
  }

  await mkdir(dirname(OUTPUT_FILE), { recursive: true })
  const temporaryFile = `${OUTPUT_FILE}.tmp`
  await writeFile(temporaryFile, JSON.stringify(dashboard), 'utf8')
  await rename(temporaryFile, OUTPUT_FILE)
  const outputStats = await stat(OUTPUT_FILE)
  console.log(`Wrote ${OUTPUT_FILE} (${(outputStats.size / 1024 / 1024).toFixed(2)} MiB)`)
  console.log(`Default replay: ${defaultScenario.at}; scenarios: ${scenarios.map((scenario) => `${scenario.label}@${scenario.at}`).join(', ')}`)
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
