// Descriptive station x weekday x half-hour profile across the whole dataset.
//
// Answers "which stations run out of bikes (or docks) at which times of week"
// before any model is involved. This is deliberately NOT the display profile in
// station-popularity.mjs: that one trims observations to +/-1 standard deviation,
// which discards exactly the low-inventory tail we need to count here.
//
// Two periods are written every run:
//   train (Jan-Apr) - safe to feed a model; matches the frozen baseline split.
//   all   (Jan-Jun) - includes the May validation and June test months, so it is
//                     for human understanding only. Using it as a model input
//                     leaks the hold-out set.
//
// Usage:
//   $env:CTRL_CITY_DATASET_DIR = "<folder with the CSVs>"
//   node --max-old-space-size=8192 app/scripts/station-time-profile.mjs

import { createReadStream } from 'node:fs'
import { createHash } from 'node:crypto'
import { mkdir, open, readFile, readdir, rename, writeFile } from 'node:fs/promises'
import { dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { parse } from 'csv-parse'
import iconv from 'iconv-lite'

import { buildExclusionIndex, parseAdjustmentsFile } from '../shared/operational-adjustments.mjs'
import { LOW_INVENTORY_POLICY } from '../shared/parameters.mjs'
import { historyPeriod } from '../shared/history-period.mjs'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const APP_DIR = resolve(SCRIPT_DIR, '..')
const REPO_DIR = resolve(APP_DIR, '..')
const SOURCE_DIR = process.env.CTRL_CITY_DATASET_DIR
  ? resolve(process.env.CTRL_CITY_DATASET_DIR)
  : resolve(REPO_DIR, 'docs', '資料集')
const ALIAS_FILE = resolve(SCRIPT_DIR, 'station-aliases.json')
const ADJUSTMENTS_FILE = resolve(APP_DIR, 'data', 'operational-adjustments.json')
const OUTPUT_DIR = resolve(REPO_DIR, 'ml', 'output')
const ROI_FILE = resolve(APP_DIR, 'data', 'operational-roi.json')
const SHARD_DIR = resolve(APP_DIR, 'public', 'data', 'roi')
const ROI_PERIOD = 'all'
const HISTORY_PERIOD = historyPeriod(process.env.CTRL_CITY_ROLLING_HISTORY === 'true')
const RECORDS_PER_STATION = HISTORY_PERIOD.days * 48
const MISSING_RECORD = 0xffff
// Cloudflare Pages rejects any single static asset over 25 MiB (the whole
// deploy fails instantly, not a real build error). One binary covering all
// 1,577 stations comes to ~27.4 MB, just over that cap, so it is split into
// fixed-size station shards well under the limit with room to grow.
const DETAIL_SHARD_COUNT = HISTORY_PERIOD.detailShardCount

const PERIOD_ORIGIN = HISTORY_PERIOD.origin
const PERIOD_DAYS = HISTORY_PERIOD.days
const DAY_MS = 24 * 60 * 60 * 1000
const BITMAP_BYTES = Math.ceil(PERIOD_DAYS / 8)

// Kept identical to evaluate-forecast.mjs (both via LOW_INVENTORY_POLICY) so
// the two reports agree on what an "empty"/"full"/"unavailable" snapshot is.
const LOW_RATIO = LOW_INVENTORY_POLICY.ratio
const LOW_FLOOR = LOW_INVENTORY_POLICY.floor

const PERIODS = Object.freeze({
  train: { label: '訓練期 1-4 月', start: Date.UTC(2026, 0, 1), end: Date.UTC(2026, 4, 1) },
  all: { label: HISTORY_PERIOD.label, start: PERIOD_ORIGIN, end: HISTORY_PERIOD.end },
})

const WEEKDAY_NAMES = ['週日', '週一', '週二', '週三', '週四', '週五', '週六']

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

// Only these are required; a file without coordinates still produces the
// weekday/slot statistics, it just cannot place stations on the map.
const REQUIRED_COLUMNS = ['observedAt', 'city', 'district', 'name', 'totalDocks', 'availableBikes', 'availableDocks']

function normalizeText(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .replace(/^﻿/, '')
    .trim()
    .replace(/\s+/g, ' ')
}

function stableId(identityKey) {
  return `st_${createHash('sha256').update(identityKey).digest('hex').slice(0, 14)}`
}

function parseLocalTimestamp(value) {
  const match = normalizeText(value).match(
    /^(\d{4})[/-](\d{1,2})[/-](\d{1,2})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?$/,
  )
  if (!match) return null

  const [, yearText, monthText, dayText, hourText, minuteText] = match
  const year = Number(yearText)
  const month = Number(monthText)
  const day = Number(dayText)
  const hour = Number(hourText)
  const minute = Number(minuteText)
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59) return null

  // Wall-clock components are treated as UTC so the weekday and slot never shift
  // with the host time zone. This matches build-artifacts.mjs.
  const bucketEpoch = Date.UTC(year, month - 1, day, hour, Math.floor(minute / 30) * 30, 0)
  const observed = new Date(bucketEpoch)
  if (observed.getUTCMonth() !== month - 1 || observed.getUTCDate() !== day) return null

  return {
    bucketEpoch,
    slot: hour * 2 + Math.floor(minute / 30),
    weekday: observed.getUTCDay(),
    dayOrdinal: Math.floor((Date.UTC(year, month - 1, day) - PERIOD_ORIGIN) / DAY_MS),
  }
}

function parseCount(value) {
  const number = Number(normalizeText(value))
  return Number.isInteger(number) && number >= 0 ? number : null
}

async function detectEncoding(filePath) {
  const handle = await open(filePath, 'r')
  try {
    const bytes = Buffer.alloc(4096)
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0)
    if (bytesRead >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return 'utf8'
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

async function streamRows(filePath, onRow) {
  const encoding = await detectEncoding(filePath)
  const parser = parse({
    bom: true,
    columns: (header) => {
      const columns = header.map((column) => HEADER_MAP.get(normalizeText(column)) ?? `unknown_${normalizeText(column)}`)
      const missing = REQUIRED_COLUMNS.filter((column) => !columns.includes(column))
      if (missing.length) throw new Error(`Unexpected CSV header in ${filePath}; missing ${missing.join(', ')}`)
      return columns
    },
    skip_empty_lines: true,
    trim: true,
    relax_column_count: false,
  })

  createReadStream(filePath).pipe(iconv.decodeStream(encoding)).pipe(parser)
  for await (const row of parser) onRow(row)
  return encoding
}

function createCell() {
  return {
    observations: 0,
    duplicateDayHits: 0,
    bikesSum: 0,
    docksSum: 0,
    empty: 0,
    full: 0,
    lowBikes: 0,
    lowDocks: 0,
    unavailable: 0,
    days: new Uint8Array(BITMAP_BYTES),
  }
}

function markDay(cell, dayOrdinal) {
  if (dayOrdinal < 0 || dayOrdinal >= PERIOD_DAYS) return
  const byte = dayOrdinal >> 3
  const bit = 1 << (dayOrdinal & 7)
  if (cell.days[byte] & bit) cell.duplicateDayHits += 1
  else cell.days[byte] |= bit
}

function countDays(cell) {
  let total = 0
  for (const byte of cell.days) {
    let value = byte
    while (value) { total += value & 1; value >>= 1 }
  }
  return total
}

function round(value, decimals = 3) {
  return Number.isFinite(value) ? Number(value.toFixed(decimals)) : 0
}

function slotLabel(slot) {
  const hour = Math.floor(slot / 2)
  return `${String(hour).padStart(2, '0')}:${slot % 2 ? '30' : '00'}`
}

async function readAdjustments() {
  try {
    return parseAdjustmentsFile(JSON.parse(await readFile(ADJUSTMENTS_FILE, 'utf8')))
  } catch (error) {
    if (error.code === 'ENOENT') return []
    throw new Error(`Could not read ${ADJUSTMENTS_FILE}: ${error.message}`)
  }
}

/**
 * Rolls the per-station cells up to the scopes the operator page offers:
 * every station, plus one scope per district. Rates are recomputed from the
 * summed counts rather than averaged, so a large station cannot be outvoted by
 * a small one inside the same district.
 */
function buildRoiArtifact(bucket, stationById, period) {
  const scopes = new Map()

  const scopeFor = (key, label) => {
    let scope = scopes.get(key)
    if (!scope) {
      scope = { label, stations: new Set(), grid: new Map() }
      scopes.set(key, scope)
    }
    return scope
  }

  const accumulate = (scope, weekday, slot, cell, stationId) => {
    scope.stations.add(stationId)
    const gridKey = weekday * 48 + slot
    let totals = scope.grid.get(gridKey)
    if (!totals) {
      totals = { observations: 0, bikesSum: 0, docksSum: 0, empty: 0, full: 0, lowBikes: 0, lowDocks: 0, unavailable: 0, stations: new Set() }
      scope.grid.set(gridKey, totals)
    }
    totals.observations += cell.observations
    totals.bikesSum += cell.bikesSum
    totals.docksSum += cell.docksSum
    totals.empty += cell.empty
    totals.full += cell.full
    totals.lowBikes += cell.lowBikes
    totals.lowDocks += cell.lowDocks
    totals.unavailable += cell.unavailable
    totals.stations.add(stationId)
  }

  for (const [cellKey, cell] of bucket) {
    if (!cell.observations) continue
    const separator = cellKey.lastIndexOf(':')
    const weekdaySeparator = cellKey.lastIndexOf(':', separator - 1)
    const stationId = cellKey.slice(0, weekdaySeparator)
    const station = stationById.get(stationId)
    if (!station) continue
    const weekday = Number(cellKey.slice(weekdaySeparator + 1, separator))
    const slot = Number(cellKey.slice(separator + 1))

    accumulate(scopeFor('', '全部行政區'), weekday, slot, cell, stationId)
    if (station.district) accumulate(scopeFor(station.district, station.district), weekday, slot, cell, stationId)
  }

  const serialised = {}
  for (const [key, scope] of scopes) {
    const grid = Array.from({ length: 7 }, () => Array.from({ length: 48 }, () => null))
    for (const [gridKey, totals] of scope.grid) {
      const weekday = Math.floor(gridKey / 48)
      const slot = gridKey % 48
      const denominator = Math.max(1, totals.observations)
      grid[weekday][slot] = [
        totals.observations,
        totals.stations.size,
        round(totals.bikesSum / denominator, 2),
        round(totals.docksSum / denominator, 2),
        round(totals.empty / denominator, 4),
        round(totals.full / denominator, 4),
        round(totals.lowBikes / denominator, 4),
        round(totals.lowDocks / denominator, 4),
        totals.unavailable,
      ]
    }
    serialised[key] = { label: scope.label, stationCount: scope.stations.size, grid }
  }

  return {
    schemaVersion: '1.0',
    generatedAt: new Date().toISOString(),
    period: period.label,
    weekdayNames: WEEKDAY_NAMES,
    valueFormat: [
      'observations', 'stations', 'meanBikes', 'meanDocks',
      'emptyRate', 'fullRate', 'lowBikesRate', 'lowDocksRate', 'unavailableCount',
    ],
    definitions: {
      emptyRate: '可借車數 = 0 的時段佔比',
      fullRate: '可還位數 = 0 的時段佔比',
      lowBikesRate: `可借車數 <= max(${LOW_FLOOR}, ceil(總車柱數 x ${LOW_RATIO}))`,
      denominator: '僅計入營運中時段；可借與可還皆為 0 的停運快照與營運調整排除窗不列入',
      caveat: '這是站點可用性，不是使用者借車成功率；使用者實際嘗試借車的紀錄不存在於資料中。',
    },
    scopes: serialised,
  }
}

/**
 * Per-station values are far too large to ship in one payload (1,576 stations x
 * 7 weekdays x 48 slots), so they are sharded by weekday and fetched on demand:
 * changing the weekday costs one request, changing district or slot costs none.
 * Rates are stored as permille integers to keep each shard around a megabyte.
 */
async function writeStationShards(bucket, stationOrder) {
  const indexById = new Map(stationOrder.map((station, index) => [station.id, index]))
  const shards = Array.from({ length: 7 }, () => (
    stationOrder.map(() => Array.from({ length: 48 }, () => null))
  ))

  for (const [cellKey, cell] of bucket) {
    if (!cell.observations) continue
    const separator = cellKey.lastIndexOf(':')
    const weekdaySeparator = cellKey.lastIndexOf(':', separator - 1)
    const index = indexById.get(cellKey.slice(0, weekdaySeparator))
    if (index === undefined) continue
    const weekday = Number(cellKey.slice(weekdaySeparator + 1, separator))
    const slot = Number(cellKey.slice(separator + 1))

    shards[weekday][index][slot] = [
      Math.round(cell.empty / cell.observations * 1000),
      Math.round(cell.full / cell.observations * 1000),
      Math.round(cell.bikesSum / cell.observations * 10),
      Math.round(cell.docksSum / cell.observations * 10),
      cell.observations,
    ]
  }

  await mkdir(SHARD_DIR, { recursive: true })
  const paths = {}
  for (let weekday = 0; weekday < 7; weekday += 1) {
    const name = `weekday-${weekday}.json`
    paths[String(weekday)] = `/data/roi/${name}`
    await writeAtomically(resolve(SHARD_DIR, name), JSON.stringify({
      weekday,
      // Positionally aligned with operational-roi.json `stations`, so the
      // station identifier is stored once instead of in every shard.
      valueFormat: ['emptyPermille', 'fullPermille', 'meanBikesX10', 'meanDocksX10', 'observations'],
      cells: shards[weekday],
    }))
  }
  return paths
}

/**
 * Every raw half-hour reading, for every station, packed into a small, fixed
 * number of binary shard files — so the UI can list the individual dates
 * behind an aggregate without shipping a per-station JSON file. A station's
 * earlier one-file-per-station JSON encoding (~66 MB / 1,568 files across
 * decimal-text arrays) was far too much to commit; this packs each reading
 * into 2 bytes (`bikes * 256 + docks`, docks capped at 255 and bikes capped
 * at 254 so the packed value never collides with the 0xFFFF
 * "missing/suspended" sentinel) at a fixed stride per station. A single
 * merged file would be ~27.4 MB, just over Cloudflare Pages' 25 MiB
 * per-asset cap, so stations are split evenly across DETAIL_SHARD_COUNT
 * files instead.
 *
 * Station order matches `roi.stations` exactly, so `stationOrder`'s array
 * index doubles as the shard + byte-offset key (see stationDetailFormat
 * written into operational-roi.json). The client fetches only its selected
 * station's ~17 KB slice via an HTTP Range request rather than downloading a
 * whole shard.
 */
async function writeStationDetail(stationOrder, detailByStation) {
  const stationsPerShard = Math.ceil(stationOrder.length / DETAIL_SHARD_COUNT)
  const paths = []
  let stationsWithData = 0

  for (let shard = 0; shard < DETAIL_SHARD_COUNT; shard += 1) {
    const shardStations = stationOrder.slice(shard * stationsPerShard, (shard + 1) * stationsPerShard)
    if (!shardStations.length) continue
    const buffer = Buffer.alloc(shardStations.length * RECORDS_PER_STATION * 2, 0xff)
    shardStations.forEach((station, indexInShard) => {
      const grid = detailByStation.get(station.id)
      if (!grid) return
      stationsWithData += 1
      const base = indexInShard * RECORDS_PER_STATION * 2
      for (let slotIndex = 0; slotIndex < RECORDS_PER_STATION; slotIndex += 1) {
        const packed = grid[slotIndex]
        const record = packed < 0
          ? MISSING_RECORD
          : Math.min(254, Math.floor(packed / 256)) * 256 + Math.min(255, packed % 256)
        buffer.writeUInt16LE(record, base + slotIndex * 2)
      }
    })

    const name = `station-details-${shard}.bin`
    const path = resolve(SHARD_DIR, name)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, buffer)
    paths.push(`/data/roi/${name}`)
  }

  return { paths, stationsPerShard, stationsWithData }
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

  const aliases = new Map(
    Object.entries(JSON.parse(await readFile(ALIAS_FILE, 'utf8')))
      .map(([raw, canonical]) => [normalizeText(raw), normalizeText(canonical)]),
  )

  const adjustments = await readAdjustments()
  const exclusions = buildExclusionIndex(adjustments)
  if (!exclusions.isEmpty) {
    console.log(`Applying ${adjustments.length} operator adjustment window(s) across ${exclusions.stationCount} station(s).`)
  }

  const stations = new Map()
  const detailByStation = new Map()
  const cells = new Map(Object.keys(PERIODS).map((name) => [name, new Map()]))
  const counters = { rawRows: 0, usedRows: 0, invalidTimestamp: 0, invalidNumeric: 0, outOfPeriod: 0, excludedByAdjustment: 0 }

  console.log(`Profiling station x weekday x half-hour from ${sourceFiles.length} CSV files…`)
  for (const filePath of sourceFiles) {
    let fileRows = 0
    const encoding = await streamRows(filePath, (row) => {
      counters.rawRows += 1
      const timestamp = parseLocalTimestamp(row.observedAt)
      if (!timestamp) { counters.invalidTimestamp += 1; return }

      const totalDocks = parseCount(row.totalDocks)
      const availableBikes = parseCount(row.availableBikes)
      const availableDocks = parseCount(row.availableDocks)
      if (totalDocks === null || availableBikes === null || availableDocks === null) {
        counters.invalidNumeric += 1
        return
      }

      const city = normalizeText(row.city)
      const district = normalizeText(row.district)
      const rawName = normalizeText(row.name)
      const canonicalName = aliases.get(rawName) ?? rawName
      const identityKey = `${city}|${district}|${canonicalName}`
      let station = stations.get(identityKey)
      if (!station) {
        station = { id: stableId(identityKey), city, district, name: canonicalName, totalDocks, latitude: null, longitude: null }
        stations.set(identityKey, station)
      }
      // Dock counts change when a station is expanded; keep the largest seen.
      if (totalDocks > station.totalDocks) station.totalDocks = totalDocks
      if (station.latitude === null) {
        const latitude = Number(normalizeText(row.latitude))
        const longitude = Number(normalizeText(row.longitude))
        if (Number.isFinite(latitude) && Number.isFinite(longitude) && latitude !== 0 && longitude !== 0) {
          station.latitude = latitude
          station.longitude = longitude
        }
      }

      // Operator-declared suspensions are dropped before any statistic sees
      // them, so a station closed for roadworks never reads as chronic demand.
      if (!exclusions.isEmpty && exclusions.excludes(station.id, timestamp.bucketEpoch)) {
        counters.excludedByAdjustment += 1
        return
      }

      const isUnavailable = availableBikes === 0 && availableDocks === 0
      const lowThreshold = Math.max(LOW_FLOOR, Math.ceil(totalDocks * LOW_RATIO))
      const cellKey = `${station.id}:${timestamp.weekday}:${timestamp.slot}`

      // Raw readings for the per-date drill-down. Suspended snapshots stay -1 so
      // the detail list cannot present them as a real zero-bike reading.
      if (!isUnavailable && timestamp.dayOrdinal >= 0 && timestamp.dayOrdinal < PERIOD_DAYS) {
        let grid = detailByStation.get(station.id)
        if (!grid) {
          grid = new Int32Array(PERIOD_DAYS * 48).fill(-1)
          detailByStation.set(station.id, grid)
        }
        grid[timestamp.dayOrdinal * 48 + timestamp.slot] = availableBikes * 256 + Math.min(255, availableDocks)
      }

      let counted = false
      for (const [name, period] of Object.entries(PERIODS)) {
        if (timestamp.bucketEpoch < period.start || timestamp.bucketEpoch >= period.end) continue
        const bucket = cells.get(name)
        let cell = bucket.get(cellKey)
        if (!cell) { cell = createCell(); bucket.set(cellKey, cell) }

        markDay(cell, timestamp.dayOrdinal)
        if (isUnavailable) {
          cell.unavailable += 1
        } else {
          cell.observations += 1
          cell.bikesSum += availableBikes
          cell.docksSum += availableDocks
          if (availableBikes === 0) cell.empty += 1
          if (availableDocks === 0) cell.full += 1
          if (availableBikes <= lowThreshold) cell.lowBikes += 1
          if (availableDocks <= lowThreshold) cell.lowDocks += 1
        }
        counted = true
      }
      if (counted) { counters.usedRows += 1; fileRows += 1 } else counters.outOfPeriod += 1
    })
    console.log(`  ${filePath.slice(filePath.lastIndexOf('\\') + 1)} [${encoding}]: ${fileRows.toLocaleString()} rows`)
  }

  const stationById = new Map([...stations.values()].map((station) => [station.id, station]))
  const summaries = {}

  for (const [name, period] of Object.entries(PERIODS)) {
    const bucket = cells.get(name)
    const lines = [[
      'stationId', 'city', 'district', 'name', 'totalDocks',
      'weekday', 'weekdayName', 'slot', 'timeLabel',
      'observations', 'distinctDays', 'unavailableCount',
      'meanBikes', 'meanDocks',
      'emptyRate', 'fullRate', 'lowBikesRate', 'lowDocksRate',
    ].join(',')]

    let duplicateDayHits = 0
    const ranked = []

    for (const [cellKey, cell] of bucket) {
      duplicateDayHits += cell.duplicateDayHits
      const separator = cellKey.lastIndexOf(':')
      const weekdaySeparator = cellKey.lastIndexOf(':', separator - 1)
      const stationId = cellKey.slice(0, weekdaySeparator)
      const weekday = Number(cellKey.slice(weekdaySeparator + 1, separator))
      const slot = Number(cellKey.slice(separator + 1))
      const station = stationById.get(stationId)
      if (!station || !cell.observations) continue

      const emptyRate = cell.empty / cell.observations
      const fullRate = cell.full / cell.observations
      const record = {
        stationId,
        station,
        weekday,
        slot,
        observations: cell.observations,
        distinctDays: countDays(cell),
        emptyRate,
        fullRate,
      }
      ranked.push(record)

      lines.push([
        stationId,
        JSON.stringify(station.city),
        JSON.stringify(station.district),
        JSON.stringify(station.name),
        station.totalDocks,
        weekday,
        WEEKDAY_NAMES[weekday],
        slot,
        slotLabel(slot),
        cell.observations,
        record.distinctDays,
        cell.unavailable,
        round(cell.bikesSum / cell.observations, 2),
        round(cell.docksSum / cell.observations, 2),
        round(emptyRate),
        round(fullRate),
        round(cell.lowBikes / cell.observations),
        round(cell.lowDocks / cell.observations),
      ].join(','))
    }

    const csvPath = resolve(OUTPUT_DIR, `station-time-profile-${name}.csv`)
    await writeAtomically(csvPath, `${lines.join('\n')}\n`)

    // Only rank cells with enough distinct days to be more than noise.
    const MIN_DAYS = 8
    const eligible = ranked.filter((record) => record.distinctDays >= MIN_DAYS)
    const top = (key) => [...eligible]
      .sort((left, right) => right[key] - left[key] || right.observations - left.observations)
      .slice(0, 40)
      .map((record) => ({
        station: `${record.station.district} ${record.station.name}`,
        totalDocks: record.station.totalDocks,
        when: `${WEEKDAY_NAMES[record.weekday]} ${slotLabel(record.slot)}`,
        rate: round(record[key]),
        distinctDays: record.distinctDays,
      }))

    summaries[name] = {
      period: period.label,
      cells: bucket.size,
      cellsWithObservations: ranked.length,
      eligibleCells: eligible.length,
      minDistinctDaysForRanking: MIN_DAYS,
      duplicateDayHits,
      chronicEmpty: top('emptyRate'),
      chronicFull: top('fullRate'),
      csv: csvPath,
    }

    console.log(`\n[${name}] ${period.label}: ${ranked.length.toLocaleString()} cells -> ${csvPath}`)
    console.log(`  duplicate (cell, day) observations: ${duplicateDayHits.toLocaleString()}`)
  }

  const roi = buildRoiArtifact(cells.get(ROI_PERIOD), stationById, PERIODS[ROI_PERIOD])
  roi.adjustmentsApplied = adjustments.length
  roi.rowsExcludedByAdjustment = counters.excludedByAdjustment

  const stationOrder = [...stations.values()]
    .filter((station) => station.latitude !== null)
    .sort((left, right) =>
      left.district.localeCompare(right.district, 'zh-Hant') ||
      left.name.localeCompare(right.name, 'zh-Hant'))
  roi.stations = stationOrder.map((station) => [
    station.id, station.district, station.name, station.totalDocks,
    round(station.latitude, 5), round(station.longitude, 5),
  ])
  roi.stationFormat = ['id', 'district', 'name', 'totalDocks', 'latitude', 'longitude']
  roi.stationShards = await writeStationShards(cells.get(ROI_PERIOD), stationOrder)
  const detail = await writeStationDetail(stationOrder, detailByStation)
  roi.stationDetailPaths = detail.paths
  roi.stationDetailFormat = {
    stationsPerShard: detail.stationsPerShard,
    recordsPerStation: RECORDS_PER_STATION,
    bytesPerRecord: 2,
    originDate: '2026-01-01',
    days: PERIOD_DAYS,
    slotsPerDay: 48,
    encoding: 'uint16 LE, bikes * 256 + docks (bikes capped at 254, docks capped at 255), 0xFFFF = unobserved or suspended',
    note: 'stationOrder index i lives in stationDetailPaths[floor(i / stationsPerShard)], '
      + 'at byte offset (i % stationsPerShard) * recordsPerStation * bytesPerRecord; fetch with an HTTP Range request',
  }

  await writeAtomically(ROI_FILE, `${JSON.stringify(roi)}\n`)
  const withoutCoordinates = stations.size - stationOrder.length
  console.log(`\nWrote ${ROI_FILE} (${Object.keys(roi.scopes).length} scopes, ${stationOrder.length} mapped stations)`)
  if (withoutCoordinates) console.log(`  ${withoutCoordinates} station(s) had no usable coordinates and are not on the map`)
  console.log(`Wrote 7 weekday shards to ${SHARD_DIR}`)
  console.log(`Wrote ${detail.paths.length} station-detail shard(s) to ${SHARD_DIR} `
    + `(${detail.stationsWithData.toLocaleString()}/${stationOrder.length} stations have readings)`)

  const summaryPath = resolve(OUTPUT_DIR, 'station-time-profile-summary.json')
  await writeAtomically(summaryPath, `${JSON.stringify({
    generatedAt: new Date().toISOString(),
    sourceDir: SOURCE_DIR,
    stations: stations.size,
    counters,
    definitions: {
      empty: '可借車數 = 0（排除可借與可還皆為 0 的停運快照）',
      full: '可還位數 = 0（排除停運快照）',
      lowBikes: `可借車數 <= max(${LOW_FLOOR}, ceil(總車柱數 x ${LOW_RATIO}))`,
      weekday: '0 = 週日，資料時間視為台北當地時間',
      slot: '0-47，每 30 分鐘一格',
    },
    warning: 'all 期間含 5 月驗證與 6 月測試資料，僅供人工判讀；模型特徵請只用 train。',
    summaries,
  }, null, 2)}\n`)

  console.log(`\nWrote ${summaryPath}`)
  console.log(`rows read=${counters.rawRows.toLocaleString()} used=${counters.usedRows.toLocaleString()} ` +
    `invalidTimestamp=${counters.invalidTimestamp} invalidNumeric=${counters.invalidNumeric} ` +
    `outOfPeriod=${counters.outOfPeriod.toLocaleString()} excludedByAdjustment=${counters.excludedByAdjustment.toLocaleString()}`)
  console.log(`stations=${stations.size.toLocaleString()}`)
}

main().catch((error) => {
  console.error(`Station time profile failed: ${error.stack ?? error.message}`)
  process.exitCode = 1
})
