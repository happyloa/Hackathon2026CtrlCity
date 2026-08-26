// Finds stations where ONE metric (available bikes, or available docks) sits at
// exactly 0 for a long unbroken run while the other metric stays nonzero.
//
// This is different from the double-zero ("雙 0") suspension already excluded
// by station-time-profile.mjs: a station reporting "0 bikes, 20 docks" for many
// consecutive half-hour readings looks identical to genuine chronic demand, but
// a run that long is far more likely to be a stuck sensor or an unreported
// closure. 交接文件 flagged this as an open gap ("需另一個 heuristic：數值連續
// N 筆凍結，N 待 EDA 決定") — this script is that EDA pass. It only reports
// candidates; nothing is excluded automatically.
//
// Reads the per-station detail files written by station-time-profile.mjs
// (public/data/roi/stations/*.json), which are already in chronological order,
// so no CSV re-scan is needed. Run `npm run data:profile` first if those files
// are missing.

import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const APP_DIR = resolve(SCRIPT_DIR, '..')
const REPO_DIR = resolve(APP_DIR, '..')
const ROI_FILE = resolve(APP_DIR, 'data', 'operational-roi.json')
const DETAIL_DIR = resolve(APP_DIR, 'public', 'data', 'roi', 'stations')
const OUTPUT_DIR = resolve(REPO_DIR, 'ml', 'output')

// A run shorter than this is ordinary demand noise, not worth reporting.
const MIN_RUN_SLOTS = Number(process.env.CTRL_CITY_FROZEN_MIN_SLOTS ?? 6) // 3 hours
const HIGH_CONFIDENCE_SLOTS = 48 // 24 hours: very unlikely to be organic

function slotToClock(slot) {
  const hour = Math.floor(slot / 2)
  return `${String(hour).padStart(2, '0')}:${slot % 2 ? '30' : '00'}`
}

function dateFromOrdinal(originEpoch, dayOrdinal) {
  const date = new Date(originEpoch + dayOrdinal * 86_400_000)
  const pad = (value) => String(value).padStart(2, '0')
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`
}

/**
 * Walks one station's grid in chronological order and returns runs where
 * `metric` (bikes or docks) stays at 0 while the other stays positive.
 */
function findRuns(detail, metric) {
  const runs = []
  let runStart = null
  let runLength = 0

  const flush = (endIndex) => {
    if (runStart !== null && runLength >= MIN_RUN_SLOTS) {
      runs.push({ startIndex: runStart, length: runLength, endIndex })
    }
    runStart = null
    runLength = 0
  }

  for (let index = 0; index < detail.grid.length; index += 1) {
    const packed = detail.grid[index]
    let matches = false
    if (packed >= 0) {
      const bikes = Math.floor(packed / 256)
      const docks = packed % 256
      matches = metric === 'bikes' ? (bikes === 0 && docks > 0) : (docks === 0 && bikes > 0)
    }

    if (matches) {
      if (runStart === null) runStart = index
      runLength += 1
    } else {
      flush(index - 1)
    }
  }
  flush(detail.grid.length - 1)
  return runs
}

async function main() {
  const roi = JSON.parse(await readFile(ROI_FILE, 'utf8'))
  const stationById = new Map(roi.stations.map(([id, district, name, totalDocks]) => [id, { id, district, name, totalDocks }]))

  const available = new Set((await readdir(DETAIL_DIR).catch(() => [])).map((name) => name.replace('.json', '')))
  if (!available.size) {
    throw new Error(`No detail files in ${DETAIL_DIR}. Run npm run data:profile first.`)
  }

  const findings = []
  for (const stationId of available) {
    const station = stationById.get(stationId)
    if (!station) continue
    const detail = JSON.parse(await readFile(resolve(DETAIL_DIR, `${stationId}.json`), 'utf8'))
    const originEpoch = Date.parse(`${detail.originDate}T00:00:00Z`)

    for (const metric of ['bikes', 'docks']) {
      for (const run of findRuns(detail, metric)) {
        const startDay = Math.floor(run.startIndex / 48)
        const startSlot = run.startIndex % 48
        const endDay = Math.floor(run.endIndex / 48)
        const endSlot = run.endIndex % 48
        findings.push({
          stationId,
          district: station.district,
          name: station.name,
          totalDocks: station.totalDocks,
          metric: metric === 'bikes' ? '可借車數' : '可還位數',
          lengthSlots: run.length,
          lengthHours: Math.round(run.length / 2 * 10) / 10,
          startDate: dateFromOrdinal(originEpoch, startDay),
          startTime: slotToClock(startSlot),
          endDate: dateFromOrdinal(originEpoch, endDay),
          endTime: slotToClock(endSlot),
          highConfidence: run.length >= HIGH_CONFIDENCE_SLOTS,
        })
      }
    }
  }

  findings.sort((left, right) => right.lengthSlots - left.lengthSlots)

  const lines = ['stationId,district,name,totalDocks,metric,lengthSlots,lengthHours,startDate,startTime,endDate,endTime,highConfidence']
  for (const finding of findings) {
    lines.push([
      finding.stationId, JSON.stringify(finding.district), JSON.stringify(finding.name), finding.totalDocks,
      finding.metric, finding.lengthSlots, finding.lengthHours,
      finding.startDate, finding.startTime, finding.endDate, finding.endTime, finding.highConfidence,
    ].join(','))
  }

  await mkdir(OUTPUT_DIR, { recursive: true })
  const csvPath = resolve(OUTPUT_DIR, 'frozen-runs.csv')
  const tmpPath = `${csvPath}.tmp`
  await writeFile(tmpPath, `${lines.join('\n')}\n`, 'utf8')
  await rename(tmpPath, csvPath)

  const highConfidence = findings.filter((finding) => finding.highConfidence)
  const stationsAffected = new Set(findings.map((finding) => finding.stationId))
  const stationsHighConfidence = new Set(highConfidence.map((finding) => finding.stationId))

  console.log(`Scanned ${available.size.toLocaleString()} stations.`)
  console.log(`Runs of >= ${MIN_RUN_SLOTS} slots (${MIN_RUN_SLOTS / 2}h): ${findings.length.toLocaleString()}, across ${stationsAffected.size.toLocaleString()} stations`)
  console.log(`  of which >= ${HIGH_CONFIDENCE_SLOTS} slots (${HIGH_CONFIDENCE_SLOTS / 2}h, high confidence): ${highConfidence.length.toLocaleString()}, across ${stationsHighConfidence.size.toLocaleString()} stations`)
  console.log(`Wrote ${csvPath}`)
  console.log(`\nTop 20 longest runs:`)
  for (const finding of findings.slice(0, 20)) {
    console.log(`  ${String(finding.lengthHours).padStart(6)}h  ${finding.metric}=0  ${finding.district}${finding.name}  ${finding.startDate} ${finding.startTime} -> ${finding.endDate} ${finding.endTime}`)
  }
}

main().catch((error) => {
  console.error(`Frozen-station scan failed: ${error.stack ?? error.message}`)
  process.exitCode = 1
})
