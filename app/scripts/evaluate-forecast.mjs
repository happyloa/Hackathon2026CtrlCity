import { createReadStream } from 'node:fs'
import { createHash } from 'node:crypto'
import { mkdir, open, readFile, readdir, rename, writeFile } from 'node:fs/promises'
import { dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { parse } from 'csv-parse'
import iconv from 'iconv-lite'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const APP_DIR = resolve(SCRIPT_DIR, '..')
const REPO_DIR = resolve(APP_DIR, '..')
const SOURCE_DIR = resolve(REPO_DIR, 'docs', '資料集')
const ALIAS_FILE = resolve(SCRIPT_DIR, 'station-aliases.json')
const OUTPUT_DIR = resolve(APP_DIR, 'server', 'data')
const OUTPUT_FILE = resolve(OUTPUT_DIR, 'forecast-evaluation.json')
const MARKDOWN_FILE = resolve(REPO_DIR, 'docs', 'MODEL_EVALUATION.md')

const HALF_HOUR_MS = 30 * 60 * 1000
const HORIZONS = [30, 60, 120]
const THRESHOLD_CANDIDATES = [0.02, 0.05, 0.1, 0.15, 0.2, 0.25, 0.3, 0.35, 0.4, 0.45, 0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8, 0.85, 0.9]
const COHORT_MODULUS = 8
const COHORT_REMAINDER = 0

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
  const aliases = JSON.parse(await readFile(ALIAS_FILE, 'utf8'))
  return new Map(Object.entries(aliases).map(([raw, canonical]) => [normalizeText(raw), normalizeText(canonical)]))
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
    station = { id: stableId(identityKey), cohort: isInEvaluationCohort(identityKey) }
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
  return `# 歷史風險啟發式基線：時間切分評估

本文件由 \`npm run model:evaluate\` 自動產生；原始 CSV 不會被複製或輸出至 Git。

## 做法

- 模型：\`${evaluation.model.version}\`。以當前站點庫存、前一個 30 分鐘桶的動量，以及「站點 × 半小時槽」的訓練期歷史空車／滿位率產生風險分數。
- 時間切分：訓練為 ${SPLITS.train.period}；閾值僅用 ${SPLITS.validation.period} 選擇；${SPLITS.test.period} 完全保留至最後測試。
- 評估事件：預測未來 30／60／120 分鐘後，站點是否為「空車或滿位」。目前或目標時點同時無車且無位的服務不可用紀錄不納入此二元庫存事件評分，會另列排除量。
- 評估樣本：以站點規格化鍵的 SHA-256 取模固定抽樣，\`hash mod ${COHORT_MODULUS} = ${COHORT_REMAINDER}\`；本次涵蓋 ${evaluation.cohort.stationCount.toLocaleString()} 個站點。抽樣規則固定，重跑可重現。

## 驗證集：閾值選擇

以 F1 最大化選擇每個預測視窗的警示閾值；同分時依序偏好較高 precision、較高 recall、較高閾值。

| 視窗 | 選定閾值 | F1 | Precision | Recall |
| --- | ---: | ---: | ---: | ---: |
${Object.entries(validation).map(([horizon, result]) => `| ${horizon} 分鐘 | ${result.threshold.toFixed(2)} | ${percent(result.inventoryIssue.f1)} | ${percent(result.inventoryIssue.precision)} | ${percent(result.inventoryIssue.recall)} |`).join('\n')}

## 保留測試集：2026 年 6 月

| 視窗 | 閾值 | 可評估預測 | Precision | Recall | F1 | 警示率 | TP / FP / FN |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
${Object.entries(test).map(([horizon, result]) => metricRow(`${horizon} 分鐘`, result)).join('\n')}

60 分鐘視窗的保留測試：F1 **${percent(test['60'].inventoryIssue.f1)}**，precision **${percent(test['60'].inventoryIssue.precision)}**，recall **${percent(test['60'].inventoryIssue.recall)}**；共 ${test['60'].inventoryIssue.predictionCount.toLocaleString()} 筆可評估預測。

## 限制與下一步

- 這是可解釋的啟發式基線，不是經校準的機率模型；風險分數的 Brier score 與 log loss 已輸出在 JSON 供後續模型比較。
- 訓練特徵刻意只使用 1 至 4 月資料，避免把 5、6 月資訊洩漏進驗證或測試。正式部署時應採滾動式重訓與相同的時間外測試。
- 固定抽樣降低本機評估的記憶體成本；上線前應在可控的批次環境對全站點重跑，並依行政區、尖離峰與空車／滿位類型檢視公平性與誤差。
- 本評估沒有使用天氣、活動、捷運班次、調度紀錄或即時事件特徵，亦未評估「服務不可用」的成因。這些資料可作為後續 Amazon SageMaker 模型的特徵與獨立標籤。
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
  const stationCache = new Map()
  const profiles = new Map()
  const timelines = { validation: new Map(), test: new Map() }
  const counters = {
    sourceFiles: sourceFiles.length,
    rawRows: 0,
    validCohortRows: 0,
    invalidTimestampRows: 0,
    invalidNumericRows: 0,
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

  const evaluation = {
    schemaVersion: '1.0',
    generatedAt: new Date().toISOString(),
    model: {
      version: 'historical-profile-heuristic-v1',
      objective: '預測未來時點是否空車或滿位',
      horizonsMinutes: HORIZONS,
      featurePolicy: '僅使用當前庫存、前一個半小時桶的庫存動量，以及訓練期站點×半小時槽統計。',
    },
    timeSplit: Object.fromEntries(Object.entries(SPLITS).map(([name, split]) => [name, split.period])),
    cohort: {
      selection: `sha256(normalized city|district|station name) mod ${COHORT_MODULUS} = ${COHORT_REMAINDER}`,
      stationCount: cohortStationIds.size,
      sampledFraction: `1/${COHORT_MODULUS}`,
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
    },
    limitations: [
      '固定站點抽樣用於控制本機記憶體，並非全站點離線評估。',
      '服務不可用（同時無車與無可還位）不納入空車／滿位二元事件指標。',
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
