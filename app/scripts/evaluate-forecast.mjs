import { createReadStream } from 'node:fs'
import { createHash } from 'node:crypto'
import { mkdir, open, readFile, readdir, rename, writeFile } from 'node:fs/promises'
import { dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { parse } from 'csv-parse'
import iconv from 'iconv-lite'

import { buildExclusionIndex, parseAdjustmentsFile } from '../shared/operational-adjustments.mjs'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const APP_DIR = resolve(SCRIPT_DIR, '..')
const REPO_DIR = resolve(APP_DIR, '..')
const SOURCE_DIR = process.env.CTRL_CITY_DATASET_DIR
  ? resolve(process.env.CTRL_CITY_DATASET_DIR)
  : resolve(REPO_DIR, 'docs', '資料集')
const ALIAS_FILE = resolve(SCRIPT_DIR, 'station-aliases.json')
const ADJUSTMENTS_FILE = resolve(APP_DIR, 'data', 'operational-adjustments.json')
// Optional: station_id,cluster_id,cluster_label rows (300m-proximity groups
// from app/scripts/analyze-high-risk-stations.mjs) for an ad hoc per-cluster
// breakdown alongside the per-district one. Silently skipped if absent.
const CLUSTER_MEMBERSHIP_FILE = resolve(REPO_DIR, 'ml', 'output', 'cluster_membership.csv')
const CLUSTER_OUTPUT_FILE = resolve(APP_DIR, 'data', 'forecast-evaluation-clusters.json')
const OUTPUT_DIR = resolve(APP_DIR, 'data')
const OUTPUT_FILE = resolve(OUTPUT_DIR, 'forecast-evaluation.json')
const MARKDOWN_FILE = resolve(REPO_DIR, 'docs', '03_實作與驗證', '歷史風險基線評估.md')

const HALF_HOUR_MS = 30 * 60 * 1000
const HORIZONS = [30, 60, 120]
const PRIMARY_HORIZON_MINUTES = 60
const MODEL_VERSION = 'historical-live-inventory-baseline-v2'
const SUFFICIENT_BASELINE_MIN_SAMPLES = 6
const HIGH_CONFIDENCE_MIN_SAMPLES = 12
const THRESHOLD_CANDIDATES = [0.02, 0.05, 0.1, 0.15, 0.2, 0.25, 0.3, 0.35, 0.4, 0.45, 0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8, 0.85, 0.9]
// Sampling exists only to cap local memory. Set CTRL_CITY_COHORT_MODULUS=1 for a
// full-station run; any other positive integer keeps the deterministic 1/N sample.
const COHORT_MODULUS = (() => {
  const raw = Number(process.env.CTRL_CITY_COHORT_MODULUS ?? 8)
  if (!Number.isInteger(raw) || raw < 1) {
    throw new Error(`CTRL_CITY_COHORT_MODULUS must be a positive integer; received ${process.env.CTRL_CITY_COHORT_MODULUS}`)
  }
  return raw
})()
const COHORT_REMAINDER = 0
const IS_FULL_COHORT = COHORT_MODULUS === 1

const SPLITS = Object.freeze({
  train: {
    label: '訓練',
    start: Date.UTC(2026, 0, 1),
    end: Date.UTC(2026, 4, 1),
    period: '2026-01-01 至 2026-04-30',
  },
  validation: {
    label: '驗證與閾值選擇',
    start: Date.UTC(2026, 4, 1),
    end: Date.UTC(2026, 5, 1),
    period: '2026-05-01 至 2026-05-31',
  },
  test: {
    label: '保留測試',
    start: Date.UTC(2026, 5, 1),
    end: Date.UTC(2026, 6, 1),
    period: '2026-06-01 至 2026-06-30',
  },
})

const HEADER_MAP = new Map([
  ['日期', 'observedAt'],
  ['城市', 'city'],
  ['行政區', 'district'],
  ['場站名稱', 'name'],
  ['總車柱數', 'totalDocks'],
  ['可借車數', 'availableBikes'],
  ['可還位數', 'availableDocks'],
])

function normalizeText(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .replace(/^\uFEFF/, '')
    .trim()
    .replace(/\s+/g, ' ')
}

function pad(value) {
  return String(value).padStart(2, '0')
}

function formatNumber(value, decimals = 3) {
  return Number(value.toFixed(decimals))
}

function clamp(value, min = 0, max = 1) {
  return Math.min(max, Math.max(min, value))
}

function stableId(identityKey) {
  return `st_${createHash('sha256').update(identityKey).digest('hex').slice(0, 14)}`
}

function isInEvaluationCohort(identityKey) {
  if (IS_FULL_COHORT) return true
  const hash = createHash('sha256').update(identityKey).digest('hex')
  return Number.parseInt(hash.slice(0, 8), 16) % COHORT_MODULUS === COHORT_REMAINDER
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
    month < 1 || month > 12 ||
    day < 1 || day > 31 ||
    hour < 0 || hour > 23 ||
    minute < 0 || minute > 59 ||
    second < 0 || second > 59
  ) return null

  const observedEpoch = Date.UTC(year, month - 1, day, hour, minute, second)
  const observed = new Date(observedEpoch)
  if (
    observed.getUTCFullYear() !== year ||
    observed.getUTCMonth() !== month - 1 ||
    observed.getUTCDate() !== day
  ) return null

  const bucketMinute = Math.floor(minute / 30) * 30
  return {
    observedEpoch,
    bucketEpoch: Date.UTC(year, month - 1, day, hour, bucketMinute, 0),
    slot: hour * 2 + Math.floor(bucketMinute / 30),
  }
}

function parseCount(value) {
  const number = Number(normalizeText(value))
  return Number.isInteger(number) && number >= 0 ? number : null
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

function splitFor(epoch) {
  for (const [name, split] of Object.entries(SPLITS)) {
    if (epoch >= split.start && epoch < split.end) return name
  }
  return null
}

function profileKey(stationId, slot) {
  return `${stationId}:${slot}`
}

async function detectEncoding(filePath) {
  const handle = await open(filePath, 'r')
  try {
    const bytes = Buffer.alloc(4096)
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0)
    const hasUtf8Bom = bytesRead >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf
    if (hasUtf8Bom) return 'utf8'
    // A leading quote or BOM is not a reliable signal: some competition exports are
    // UTF-8 with neither. Strict-decode the header line instead — CP950 byte pairs
    // are almost never valid UTF-8, so a clean decode means the file really is UTF-8.
    try {
      const lineFeed = bytes.subarray(0, bytesRead).indexOf(0x0a)
      const sampleEnd = lineFeed >= 0 ? lineFeed + 1 : bytesRead
      new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, sampleEnd))
      return 'utf8'
    } catch {
      return 'cp950'
    }
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
  const aliases = JSON.parse(await readFile(ALIAS_FILE, 'utf8'))
  return new Map(Object.entries(aliases).map(([raw, canonical]) => [normalizeText(raw), normalizeText(canonical)]))
}

async function readClusterMembership() {
  let raw
  try {
    raw = await readFile(CLUSTER_MEMBERSHIP_FILE, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
  const membership = new Map()
  const labels = new Map()
  for (const line of raw.trim().split('\n').slice(1)) {
    const [stationId, clusterId, clusterLabel] = line.split(',')
    if (!stationId || !clusterId) continue
    membership.set(stationId, clusterId)
    labels.set(clusterId, clusterLabel)
  }
  return { membership, labels }
}

async function readAdjustments() {
  try {
    return parseAdjustmentsFile(JSON.parse(await readFile(ADJUSTMENTS_FILE, 'utf8')))
  } catch (error) {
    if (error.code === 'ENOENT') return []
    throw new Error(`Could not read ${ADJUSTMENTS_FILE}: ${error.message}`)
  }
}

async function streamRows(filePath, onRow) {
  const encoding = await detectEncoding(filePath)
  const input = createReadStream(filePath)
  const decoder = iconv.decodeStream(encoding)
  let headerValidated = false
  const parser = parse({
    bom: true,
    columns: (header) => {
      const columns = header.map((column) => HEADER_MAP.get(normalizeText(column)) ?? `unknown_${normalizeText(column)}`)
      const expected = ['observedAt', 'city', 'district', 'name', 'totalDocks', 'availableBikes', 'availableDocks']
      const missing = expected.filter((column) => !columns.includes(column))
      if (missing.length) throw new Error(`Unexpected CSV header in ${filePath}; missing ${missing.join(', ')}`)
      headerValidated = true
      return columns
    },
    skip_empty_lines: true,
    trim: true,
    relax_column_count: false,
  })

  input.pipe(decoder).pipe(parser)
  for await (const row of parser) await onRow(row)
  if (!headerValidated) throw new Error(`CSV header was not read from ${filePath}`)
  return encoding
}

function parseSnapshot(row, aliases, stationCache, counters) {
  const timestamp = parseLocalTimestamp(row.observedAt)
  if (!timestamp) {
    counters.invalidTimestampRows += 1
    return null
  }

  const totalDocks = parseCount(row.totalDocks)
  const availableBikes = parseCount(row.availableBikes)
  const availableDocks = parseCount(row.availableDocks)
  if (totalDocks === null || availableBikes === null || availableDocks === null) {
    counters.invalidNumericRows += 1
    return null
  }

  const city = normalizeText(row.city)
  const district = normalizeText(row.district)
  const rawName = normalizeText(row.name)
  const canonicalName = aliases.get(rawName) ?? rawName
  const identityKey = `${city}|${district}|${canonicalName}`
  let station = stationCache.get(identityKey)
  if (!station) {
    station = { id: stableId(identityKey), cohort: isInEvaluationCohort(identityKey), district }
    stationCache.set(identityKey, station)
  }
  if (!station.cohort) return null

  return {
    ...timestamp,
    id: station.id,
    totalDocks,
    availableBikes,
    availableDocks,
    currentState: stateForSnapshot(totalDocks, availableBikes, availableDocks),
  }
}

function updateProfile(profiles, snapshot) {
  const key = profileKey(snapshot.id, snapshot.slot)
  let profile = profiles.get(key)
  if (!profile) {
    profile = { observations: 0, bikesSum: 0, docksSum: 0, empty: 0, full: 0, unavailable: 0 }
    profiles.set(key, profile)
  }

  if (snapshot.currentState === 'unavailable') {
    profile.unavailable += 1
    return
  }
  profile.observations += 1
  profile.bikesSum += snapshot.availableBikes
  profile.docksSum += snapshot.availableDocks
  if (snapshot.currentState === 'empty') profile.empty += 1
  if (snapshot.currentState === 'full') profile.full += 1
}

function captureSnapshot(timelines, snapshot) {
  let timeline = timelines.get(snapshot.id)
  if (!timeline) {
    timeline = new Map()
    timelines.set(snapshot.id, timeline)
  }
  const previous = timeline.get(snapshot.bucketEpoch)
  if (!previous || snapshot.observedEpoch >= previous.observedEpoch) timeline.set(snapshot.bucketEpoch, snapshot)
}

function forecastRisk(snapshot, previous, horizonMinutes, profiles) {
  const targetEpoch = snapshot.bucketEpoch + horizonMinutes * 60 * 1000
  const targetSlot = new Date(targetEpoch).getUTCHours() * 2 + Math.floor(new Date(targetEpoch).getUTCMinutes() / 30)
  const profile = profiles.get(profileKey(snapshot.id, targetSlot))
  const observations = profile?.observations ?? 0
  const profileEmptyRisk = observations ? profile.empty / observations : 0
  const profileFullRisk = observations ? profile.full / observations : 0
  const profileUnavailableRisk = profile
    ? profile.unavailable / Math.max(1, profile.observations + profile.unavailable)
    : 0
  const lowThreshold = Math.max(2, Math.ceil(snapshot.totalDocks * 0.1))
  const bikeRatio = snapshot.availableBikes / Math.max(1, snapshot.totalDocks)
  const dockRatio = snapshot.availableDocks / Math.max(1, snapshot.totalDocks)
  const bikeMomentum = previous ? snapshot.availableBikes - previous.availableBikes : 0
  const dockMomentum = previous ? snapshot.availableDocks - previous.availableDocks : 0

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

  return {
    emptyRisk: clamp(emptyRisk),
    fullRisk: clamp(fullRisk),
    unavailableRisk: clamp(unavailableRisk),
    inventoryRisk: clamp(Math.max(emptyRisk, fullRisk)),
    profileObservations: observations,
  }
}

function createConfusion() {
  return { tp: 0, fp: 0, fn: 0, tn: 0 }
}

function updateConfusion(confusion, predicted, actual) {
  if (predicted && actual) confusion.tp += 1
  else if (predicted) confusion.fp += 1
  else if (actual) confusion.fn += 1
  else confusion.tn += 1
}

function finalizeConfusion(confusion) {
  const total = confusion.tp + confusion.fp + confusion.fn + confusion.tn
  const precision = confusion.tp + confusion.fp ? confusion.tp / (confusion.tp + confusion.fp) : 0
  const recall = confusion.tp + confusion.fn ? confusion.tp / (confusion.tp + confusion.fn) : 0
  const f1 = precision + recall ? 2 * precision * recall / (precision + recall) : 0
  const specificity = confusion.tn + confusion.fp ? confusion.tn / (confusion.tn + confusion.fp) : 0
  return {
    ...confusion,
    predictionCount: total,
    precision: formatNumber(precision),
    recall: formatNumber(recall),
    f1: formatNumber(f1),
    specificity: formatNumber(specificity),
    alertRate: formatNumber(total ? (confusion.tp + confusion.fp) / total : 0),
  }
}

function createProbabilityStats() {
  return { count: 0, positives: 0, scoreSum: 0, brierSum: 0, logLossSum: 0 }
}

function updateProbabilityStats(stats, score, actual) {
  const safeScore = clamp(score, 0.000001, 0.999999)
  stats.count += 1
  stats.positives += Number(actual)
  stats.scoreSum += score
  stats.brierSum += (score - Number(actual)) ** 2
  stats.logLossSum += -(actual ? Math.log(safeScore) : Math.log(1 - safeScore))
}

function finalizeProbabilityStats(stats) {
  return {
    predictionCount: stats.count,
    actualPositive: stats.positives,
    baseRate: formatNumber(stats.count ? stats.positives / stats.count : 0),
    meanRisk: formatNumber(stats.count ? stats.scoreSum / stats.count : 0),
    brierScore: formatNumber(stats.count ? stats.brierSum / stats.count : 0),
    logLoss: formatNumber(stats.count ? stats.logLossSum / stats.count : 0),
  }
}

function createHorizonAccumulator(thresholds = []) {
  return {
    candidates: new Map(thresholds.map((threshold) => [threshold, createConfusion()])),
    appliedThreshold: thresholds.length === 1 ? thresholds[0] : null,
    combined: createConfusion(),
    empty: createConfusion(),
    full: createConfusion(),
    combinedProbabilities: createProbabilityStats(),
    emptyProbabilities: createProbabilityStats(),
    fullProbabilities: createProbabilityStats(),
    missingFutureSnapshot: 0,
    excludedUnavailableCurrent: 0,
    excludedUnavailableTarget: 0,
    profileObservationsSum: 0,
    profileCoverageCount: 0,
  }
}

function recordPrediction(accumulator, risk, target) {
  const actualCombined = target.currentState === 'empty' || target.currentState === 'full'
  const actualEmpty = target.currentState === 'empty'
  const actualFull = target.currentState === 'full'
  updateProbabilityStats(accumulator.combinedProbabilities, risk.inventoryRisk, actualCombined)
  updateProbabilityStats(accumulator.emptyProbabilities, risk.emptyRisk, actualEmpty)
  updateProbabilityStats(accumulator.fullProbabilities, risk.fullRisk, actualFull)
  accumulator.profileObservationsSum += risk.profileObservations
  accumulator.profileCoverageCount += 1

  for (const [threshold, confusion] of accumulator.candidates) {
    updateConfusion(confusion, risk.inventoryRisk >= threshold, actualCombined)
  }
  if (accumulator.appliedThreshold !== null) {
    const threshold = accumulator.appliedThreshold
    updateConfusion(accumulator.combined, risk.inventoryRisk >= threshold, actualCombined)
    updateConfusion(accumulator.empty, risk.emptyRisk >= threshold, actualEmpty)
    updateConfusion(accumulator.full, risk.fullRisk >= threshold, actualFull)
  }
}

function evaluateTimelines(timelines, profiles, thresholdsByHorizon = null) {
  const horizons = new Map()
  for (const horizon of HORIZONS) {
    const thresholds = thresholdsByHorizon ? [thresholdsByHorizon[horizon]] : THRESHOLD_CANDIDATES
    horizons.set(horizon, createHorizonAccumulator(thresholds))
  }

  for (const timeline of timelines.values()) {
    for (const snapshot of timeline.values()) {
      for (const horizon of HORIZONS) {
        const accumulator = horizons.get(horizon)
        const target = timeline.get(snapshot.bucketEpoch + horizon * 60 * 1000)
        if (!target) {
          accumulator.missingFutureSnapshot += 1
          continue
        }
        if (snapshot.currentState === 'unavailable') {
          accumulator.excludedUnavailableCurrent += 1
          continue
        }
        if (target.currentState === 'unavailable') {
          accumulator.excludedUnavailableTarget += 1
          continue
        }
        const previous = timeline.get(snapshot.bucketEpoch - HALF_HOUR_MS)
        recordPrediction(accumulator, forecastRisk(snapshot, previous, horizon, profiles), target)
      }
    }
  }
  return horizons
}

/**
 * Same confusion-matrix logic as evaluateTimelines, but grouped by an
 * arbitrary key (district) instead of pooled across every station. Used only
 * for the already-selected test-split thresholds, so it only needs the
 * combined empty/full confusion matrix, not the threshold sweep or the
 * separate empty/full/probability breakdowns.
 */
function evaluateTimelinesByGroup(timelines, profiles, thresholdsByHorizon, groupKeyFor) {
  const groups = new Map()
  for (const [stationId, timeline] of timelines.entries()) {
    const groupKey = groupKeyFor(stationId)
    if (groupKey == null) continue
    let group = groups.get(groupKey)
    if (!group) {
      group = { stationIds: new Set(), byHorizon: new Map(HORIZONS.map((horizon) => [horizon, createConfusion()])) }
      groups.set(groupKey, group)
    }
    group.stationIds.add(stationId)

    for (const snapshot of timeline.values()) {
      for (const horizon of HORIZONS) {
        const target = timeline.get(snapshot.bucketEpoch + horizon * 60 * 1000)
        if (!target) continue
        if (snapshot.currentState === 'unavailable') continue
        if (target.currentState === 'unavailable') continue
        const previous = timeline.get(snapshot.bucketEpoch - HALF_HOUR_MS)
        const risk = forecastRisk(snapshot, previous, horizon, profiles)
        const actual = target.currentState === 'empty' || target.currentState === 'full'
        updateConfusion(group.byHorizon.get(horizon), risk.inventoryRisk >= thresholdsByHorizon[horizon], actual)
      }
    }
  }
  return groups
}

function serializeGroups(groups) {
  const result = {}
  for (const [groupKey, group] of groups) {
    result[groupKey] = {
      stationCount: group.stationIds.size,
      horizons: Object.fromEntries(HORIZONS.map((horizon) => [horizon, finalizeConfusion(group.byHorizon.get(horizon))])),
    }
  }
  return result
}

function selectThreshold(accumulator) {
  const candidates = [...accumulator.candidates.entries()].map(([threshold, confusion]) => ({
    threshold,
    metrics: finalizeConfusion(confusion),
  }))
  candidates.sort((left, right) =>
    right.metrics.f1 - left.metrics.f1 ||
    right.metrics.precision - left.metrics.precision ||
    right.metrics.recall - left.metrics.recall ||
    right.threshold - left.threshold,
  )
  const selected = candidates[0]
  if (!selected) throw new Error('No threshold candidates were evaluated')
  return selected
}

function serializeApplied(accumulator) {
  return {
    threshold: accumulator.appliedThreshold,
    inventoryIssue: finalizeConfusion(accumulator.combined),
    empty: finalizeConfusion(accumulator.empty),
    full: finalizeConfusion(accumulator.full),
    probabilityQuality: {
      inventoryIssue: finalizeProbabilityStats(accumulator.combinedProbabilities),
      empty: finalizeProbabilityStats(accumulator.emptyProbabilities),
      full: finalizeProbabilityStats(accumulator.fullProbabilities),
    },
    coverage: {
      missingFutureSnapshot: accumulator.missingFutureSnapshot,
      excludedUnavailableCurrent: accumulator.excludedUnavailableCurrent,
      excludedUnavailableTarget: accumulator.excludedUnavailableTarget,
      averageHistoricalProfileObservations: formatNumber(
        accumulator.profileCoverageCount ? accumulator.profileObservationsSum / accumulator.profileCoverageCount : 0,
      ),
    },
  }
}

function percent(value) {
  return `${(value * 100).toFixed(1)}%`
}

function metricRow(label, result) {
  const inventory = result.inventoryIssue
  return `| ${label} | ${result.threshold.toFixed(2)} | ${inventory.predictionCount.toLocaleString()} | ${percent(inventory.precision)} | ${percent(inventory.recall)} | ${percent(inventory.f1)} | ${percent(inventory.alertRate)} | ${inventory.tp.toLocaleString()} / ${inventory.fp.toLocaleString()} / ${inventory.fn.toLocaleString()} |`
}

function markdownFor(evaluation) {
  const validation = evaluation.validation.horizons
  const test = evaluation.test.horizons
  return `# 歷史風險基線評估

此檔由 \`npm run model:evaluate\` 產生；原始 CSV 不會進入 Git。

## 做法

- 資料契約為 \`${evaluation.model.version}\`，主判讀窗為 **60 分鐘**。模型使用目前庫存、前一個 30 分鐘時槽的變化，以及同站歷史空／滿率。
- 離線評估用歷史快照模擬即時庫存；網站則把同一套基線逐站對照官方即時資料。
- 靜態基線只含樣本數、平均庫存與風險率，不含原始 CSV 或單筆快照。少於 ${SUFFICIENT_BASELINE_MIN_SAMPLES} 筆會標示樣本有限；${HIGH_CONFIDENCE_MIN_SAMPLES} 筆以上只代表資料較多，不代表機率已校準。
- 時間切分：${SPLITS.train.period} 訓練、${SPLITS.validation.period} 選閾值、${SPLITS.test.period} 最後測試。
- 目標是判斷 30／60／120 分鐘後是否空車或滿位。可借、可還皆為 0 的服務異常快照會排除，不當成庫存事件。
- ${IS_FULL_COHORT
    ? `**全站評估**，共 ${evaluation.cohort.stationCount.toLocaleString()} 站，未做任何抽樣。`
    : `以站點鍵的 SHA-256 固定抽樣 \`hash mod ${COHORT_MODULUS} = ${COHORT_REMAINDER}\`，共 ${evaluation.cohort.stationCount.toLocaleString()} 站；重跑可得到相同樣本。`}

## 驗證集：閾值選擇

各視窗選擇 F1 最高的閾值；同分時依序比較 precision、recall 與閾值。

| 視窗 | 選定閾值 | F1 | Precision | Recall |
| --- | ---: | ---: | ---: | ---: |
${Object.entries(validation).map(([horizon, result]) => `| ${horizon} 分鐘 | ${result.threshold.toFixed(2)} | ${percent(result.inventoryIssue.f1)} | ${percent(result.inventoryIssue.precision)} | ${percent(result.inventoryIssue.recall)} |`).join('\n')}

## 保留測試集：2026 年 6 月

| 視窗 | 閾值 | 可評估預測 | Precision | Recall | F1 | 警示率 | TP / FP / FN |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
${Object.entries(test).map(([horizon, result]) => metricRow(`${horizon} 分鐘`, result)).join('\n')}

60 分鐘保留測試共有 ${test['60'].inventoryIssue.predictionCount.toLocaleString()} 筆：F1 **${percent(test['60'].inventoryIssue.f1)}**、precision **${percent(test['60'].inventoryIssue.precision)}**、recall **${percent(test['60'].inventoryIssue.recall)}**。

## 限制與下一步

- 這是可解釋的啟發式基線，不是校準後的機率模型。Brier score 與 log loss 留在 JSON 供後續比較。
- 時間切分可避免資料洩漏；正式上線後仍需滾動重訓與時間外測試。
- ${IS_FULL_COHORT
    ? '本次已涵蓋全站，後續仍應分行政區、尖離峰及空／滿類型檢查誤差。'
    : '固定抽樣是為了降低本機記憶體用量。上線前應重跑全站，並分行政區、尖離峰及空／滿類型檢查誤差。'}
- 首次開頁沒有前一時槽的頁面內變化量，會採較保守的判讀；仍需另測 cold start。
- 目前未納入天氣、活動、捷運班次、道路、調度紀錄或服務異常成因。
`
}

async function writeAtomically(filePath, contents) {
  await mkdir(dirname(filePath), { recursive: true })
  const temporary = `${filePath}.tmp`
  await writeFile(temporary, contents, 'utf8')
  await rename(temporary, filePath)
}

async function main() {
  const sourceFiles = await listSourceFiles()
  if (!sourceFiles.length) throw new Error(`No CSV files were found at ${SOURCE_DIR}`)

  const aliases = await loadAliases()
  const adjustments = await readAdjustments()
  const exclusions = buildExclusionIndex(adjustments)
  if (!exclusions.isEmpty) {
    console.log(`Applying ${adjustments.length} operator adjustment window(s) across ${exclusions.stationCount} station(s).`)
  }
  const stationCache = new Map()
  const profiles = new Map()
  const timelines = { validation: new Map(), test: new Map() }
  const counters = {
    sourceFiles: sourceFiles.length,
    rawRows: 0,
    validCohortRows: 0,
    invalidTimestampRows: 0,
    invalidNumericRows: 0,
    excludedByAdjustment: 0,
    trainRows: 0,
    validationRows: 0,
    testRows: 0,
    encodings: {},
  }

  console.log(`Evaluating frozen time split from ${sourceFiles.length} CSV files…`)
  for (const filePath of sourceFiles) {
    let fileRows = 0
    const encoding = await streamRows(filePath, async (row) => {
      counters.rawRows += 1
      const snapshot = parseSnapshot(row, aliases, stationCache, counters)
      if (!snapshot) return
      if (!exclusions.isEmpty && exclusions.excludes(snapshot.id, snapshot.bucketEpoch)) {
        counters.excludedByAdjustment += 1
        return
      }
      counters.validCohortRows += 1
      fileRows += 1
      const split = splitFor(snapshot.bucketEpoch)
      if (split === 'train') {
        counters.trainRows += 1
        updateProfile(profiles, snapshot)
      } else if (split === 'validation' || split === 'test') {
        counters[`${split}Rows`] += 1
        captureSnapshot(timelines[split], snapshot)
      }
    })
    counters.encodings[encoding] = (counters.encodings[encoding] ?? 0) + 1
    console.log(`  ${filePath.slice(filePath.lastIndexOf('\\') + 1)}: ${fileRows.toLocaleString()} cohort rows`)
  }

  const cohortStationIds = new Set()
  for (const timelinesBySplit of Object.values(timelines)) {
    for (const id of timelinesBySplit.keys()) cohortStationIds.add(id)
  }
  for (const [identity, station] of stationCache) {
    if (station.cohort) cohortStationIds.add(station.id)
  }

  const calibration = evaluateTimelines(timelines.validation, profiles)
  const thresholds = {}
  const calibrationSelection = {}
  for (const horizon of HORIZONS) {
    const selection = selectThreshold(calibration.get(horizon))
    thresholds[horizon] = selection.threshold
    calibrationSelection[horizon] = selection
  }
  const validationApplied = evaluateTimelines(timelines.validation, profiles, thresholds)
  const testApplied = evaluateTimelines(timelines.test, profiles, thresholds)

  const districtByStationId = new Map()
  for (const station of stationCache.values()) {
    if (station.cohort) districtByStationId.set(station.id, station.district)
  }
  const testByDistrictGroups = evaluateTimelinesByGroup(
    timelines.test,
    profiles,
    thresholds,
    (stationId) => districtByStationId.get(stationId) ?? null,
  )
  const testByDistrict = serializeGroups(testByDistrictGroups)

  const clusterMembership = await readClusterMembership()
  if (clusterMembership) {
    const testByClusterGroups = evaluateTimelinesByGroup(
      timelines.test,
      profiles,
      thresholds,
      (stationId) => clusterMembership.membership.get(stationId) ?? null,
    )
    const testByCluster = serializeGroups(testByClusterGroups)
    for (const [clusterId, entry] of Object.entries(testByCluster)) {
      entry.label = clusterMembership.labels.get(clusterId) ?? clusterId
    }
    await writeAtomically(CLUSTER_OUTPUT_FILE, `${JSON.stringify({ generatedAt: new Date().toISOString(), testByCluster }, null, 2)}\n`)
    console.log(`Wrote ${CLUSTER_OUTPUT_FILE} (${Object.keys(testByCluster).length} clusters)`)
  }

  const evaluation = {
    schemaVersion: '1.0',
    generatedAt: new Date().toISOString(),
    model: {
      version: MODEL_VERSION,
      objective: '預測未來時點是否空車或滿位',
      horizonsMinutes: HORIZONS,
      primaryHorizonMinutes: PRIMARY_HORIZON_MINUTES,
      featurePolicy: '僅使用當前庫存、前一個半小時桶的庫存動量，以及訓練期站點×半小時槽統計。',
    },
    runtimeContract: {
      schemaVersion: '1.0',
      primaryHorizonMinutes: PRIMARY_HORIZON_MINUTES,
      objective: 'station_empty_or_full_inventory_risk',
      method: 'historical_station_slot_baseline_plus_live_inventory',
      inputPolicy: ['historical_station_slot_profile', 'current_live_inventory', 'page_session_momentum_optional'],
      confidencePolicy: {
        limitedMaxSampleSize: SUFFICIENT_BASELINE_MIN_SAMPLES - 1,
        sufficientMinSampleSize: SUFFICIENT_BASELINE_MIN_SAMPLES,
        highConfidenceMinSampleSize: HIGH_CONFIDENCE_MIN_SAMPLES,
      },
    },
    timeSplit: Object.fromEntries(Object.entries(SPLITS).map(([name, split]) => [name, split.period])),
    cohort: {
      selection: IS_FULL_COHORT
        ? 'all stations (no sampling)'
        : `sha256(normalized city|district|station name) mod ${COHORT_MODULUS} = ${COHORT_REMAINDER}`,
      stationCount: cohortStationIds.size,
      sampledFraction: IS_FULL_COHORT ? '1/1 (full cohort)' : `1/${COHORT_MODULUS}`,
      fullCohort: IS_FULL_COHORT,
    },
    data: {
      sourceFiles: counters.sourceFiles,
      rawRowsRead: counters.rawRows,
      cohortRowsRead: counters.validCohortRows,
      trainRows: counters.trainRows,
      validationRows: counters.validationRows,
      testRows: counters.testRows,
      trainingProfiles: profiles.size,
      invalidTimestampRows: counters.invalidTimestampRows,
      invalidNumericRows: counters.invalidNumericRows,
      excludedByAdjustment: counters.excludedByAdjustment,
      adjustmentsApplied: adjustments.length,
      encodings: counters.encodings,
    },
    thresholdSelection: {
      split: 'validation',
      criterion: '最大化 combined empty/full event F1；同分時依序較高 precision、較高 recall、較高 threshold。',
      candidates: THRESHOLD_CANDIDATES,
      selected: Object.fromEntries(HORIZONS.map((horizon) => [
        horizon,
        {
          threshold: calibrationSelection[horizon].threshold,
          inventoryIssue: calibrationSelection[horizon].metrics,
        },
      ])),
    },
    validation: {
      split: '2026-05',
      horizons: Object.fromEntries(HORIZONS.map((horizon) => [horizon, serializeApplied(validationApplied.get(horizon))])),
    },
    test: {
      split: '2026-06',
      horizons: Object.fromEntries(HORIZONS.map((horizon) => [horizon, serializeApplied(testApplied.get(horizon))])),
      byDistrict: testByDistrict,
    },
    limitations: [
      IS_FULL_COHORT
        ? '本次為全站點離線評估，未做站點抽樣。'
        : '固定站點抽樣用於控制本機記憶體，並非全站點離線評估。',
      '同時無車與無可還位的疑似服務異常快照不納入空車／滿位二元事件指標。',
      '未使用天氣、活動、交通、調度或即時事件資料；結果是啟發式基線而非可校準機率模型。',
      '每次重跑會更新 generatedAt，但資料切分、特徵、閾值候選與抽樣規則固定。',
    ],
  }

  await writeAtomically(OUTPUT_FILE, `${JSON.stringify(evaluation, null, 2)}\n`)
  await writeAtomically(MARKDOWN_FILE, markdownFor(evaluation))
  console.log(`Wrote ${OUTPUT_FILE}`)
  console.log(`Wrote ${MARKDOWN_FILE}`)
  console.log(`June 60-minute test F1: ${percent(evaluation.test.horizons['60'].inventoryIssue.f1)}; precision: ${percent(evaluation.test.horizons['60'].inventoryIssue.precision)}; recall: ${percent(evaluation.test.horizons['60'].inventoryIssue.recall)}`)
}

main().catch((error) => {
  console.error(`Forecast evaluation failed: ${error.stack ?? error.message}`)
  process.exitCode = 1
})
